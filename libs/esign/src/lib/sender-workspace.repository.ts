import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { EnvelopeIllegalTransitionError, EnvelopeNotFoundError } from './domain/errors.js';

// PX-V1 PX-1 — the authenticated SENDER workspace reads + DRAFT authoring writes.
//
// Every query is tenant-scoped by the caller-supplied tenant_id, which the sender
// controller takes ONLY from the verified auth context (never the request body).
// Authoring writes are DRAFT-only: each runs in a transaction that locks the
// envelope row and refuses any status other than DRAFT, so a sent / terminal
// envelope can never have its documents, recipients or fields changed. Lifecycle
// transitions (send / remind / void) stay on EsignService — this repository never
// changes an envelope's status.

// The sender workspace covers envelopes AUTHORED in Aramo Sign only: an envelope
// with any CORE_REF document (an ATS/Core flow such as an RTR or offer letter,
// sourced from Core Documents) is outside it. Surfacing those in the Sign console
// is a proposed capability (Sign handoff · Integrations) and would bypass the
// ATS's own visibility rules, so every sender read applies this predicate.
export const SENDER_AUTHORED = { documents: { none: { source_mode: 'CORE_REF' } } } as const;

type Db = Pick<PrismaService, 'signatureEnvelope' | 'envelopeDocument' | 'signer' | 'signatureField' | 'signatureEvent'>;

export interface SenderEnvelopeListFilter {
  tenant_id: string;
  statuses?: readonly string[];
  // Case-insensitive match on subject or any recipient name / email.
  q?: string;
  // Only envelopes created at or after this instant.
  created_since?: Date;
  // Only envelopes created by this user (Personal workspace "my documents").
  created_by?: string;
  limit: number;
}

export interface SenderRecipientInput {
  // Existing signer id to keep (and update), or absent for a new recipient.
  id?: string;
  name: string;
  email: string;
}

export interface SenderFieldInput {
  envelope_document_id: string;
  signer_id: string;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
}

export interface SenderDocumentRow {
  id: string;
  title: string;
  ordinal: number;
  source_mode: string;
  content_type: string | null;
  byte_size: number | null;
  source_sha256: string;
}

@Injectable()
export class EsignSenderRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listEnvelopes(filter: SenderEnvelopeListFilter) {
    const q = filter.q?.trim();
    return this.prisma.signatureEnvelope.findMany({
      where: {
        tenant_id: filter.tenant_id,
        ...SENDER_AUTHORED,
        ...(filter.statuses !== undefined && filter.statuses.length > 0 ? { status: { in: [...filter.statuses] } } : {}),
        ...(filter.created_since !== undefined ? { created_at: { gte: filter.created_since } } : {}),
        ...(filter.created_by !== undefined ? { created_by: filter.created_by } : {}),
        ...(q !== undefined && q.length > 0
          ? {
              OR: [
                { subject: { contains: q, mode: 'insensitive' as const } },
                { signers: { some: { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }] } } },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      include: {
        signers: { orderBy: { signing_order: 'asc' }, select: { id: true, name: true, email: true, status: true } },
        documents: { select: { id: true } },
      },
    });
  }

  async countByStatus(tenant_id: string, created_by?: string): Promise<Record<string, number>> {
    const rows = await this.prisma.signatureEnvelope.groupBy({
      by: ['status'],
      where: { tenant_id, ...SENDER_AUTHORED, ...(created_by !== undefined ? { created_by } : {}) },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  // Last ledger event per envelope (for "last activity" columns).
  async lastEventAt(tenant_id: string, envelope_ids: readonly string[]): Promise<Map<string, Date>> {
    if (envelope_ids.length === 0) return new Map();
    const rows = await this.prisma.signatureEvent.groupBy({
      by: ['envelope_id'],
      where: { tenant_id, envelope_id: { in: [...envelope_ids] } },
      _max: { occurred_at: true },
    });
    const out = new Map<string, Date>();
    for (const r of rows) if (r._max.occurred_at !== null) out.set(r.envelope_id, r._max.occurred_at);
    return out;
  }

  async getEnvelopeDetail(tenant_id: string, envelope_id: string) {
    const env = await this.prisma.signatureEnvelope.findFirst({
      where: { tenant_id, id: envelope_id, ...SENDER_AUTHORED },
      include: {
        documents: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, title: true, ordinal: true, source_mode: true, content_type: true, byte_size: true, source_sha256: true, fields: true },
        },
        signers: { orderBy: { signing_order: 'asc' } },
      },
    });
    if (env === null) throw new EnvelopeNotFoundError(envelope_id);
    return env;
  }

  async getDocument(tenant_id: string, envelope_id: string, document_id: string) {
    const doc = await this.prisma.envelopeDocument.findFirst({ where: { tenant_id, envelope_id, id: document_id, envelope: SENDER_AUTHORED } });
    if (doc === null) throw new EnvelopeNotFoundError(`${envelope_id}/${document_id}`);
    return doc;
  }

  async listEnvelopeEvents(tenant_id: string, envelope_id: string) {
    return this.prisma.signatureEvent.findMany({
      where: { tenant_id, envelope_id, envelope: SENDER_AUTHORED },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      select: { id: true, event_type: true, actor_type: true, actor_ref: true, signer_id: true, payload: true, occurred_at: true, event_hash: true },
    });
  }

  // Tenant-wide activity (newest first), with the envelope subject.
  async listTenantEvents(tenant_id: string, limit: number, envelope_created_by?: string) {
    const events = await this.prisma.signatureEvent.findMany({
      where: {
        tenant_id,
        envelope: { ...SENDER_AUTHORED, ...(envelope_created_by !== undefined ? { created_by: envelope_created_by } : {}) },
      },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        envelope_id: true,
        event_type: true,
        actor_type: true,
        actor_ref: true,
        signer_id: true,
        payload: true,
        occurred_at: true,
        event_hash: true,
        envelope: { select: { subject: true } },
      },
    });
    return events;
  }

  async listTenantDocuments(tenant_id: string, limit: number, created_by?: string) {
    return this.prisma.envelopeDocument.findMany({
      where: { tenant_id, source_mode: 'OWNED', envelope: { ...SENDER_AUTHORED, ...(created_by !== undefined ? { created_by } : {}) } },
      orderBy: [{ envelope: { created_at: 'desc' } }, { ordinal: 'asc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        source_mode: true,
        content_type: true,
        byte_size: true,
        envelope: { select: { id: true, subject: true, status: true, created_by: true, created_at: true } },
      },
    });
  }

  // Contacts derived from past recipients (no separate contact store exists).
  async listPastRecipients(tenant_id: string, limit: number) {
    return this.prisma.signer.findMany({
      where: { tenant_id, envelope: SENDER_AUTHORED },
      orderBy: [{ envelope: { created_at: 'desc' } }],
      take: limit * 4,
      select: { name: true, email: true, envelope: { select: { id: true, created_at: true } } },
    });
  }

  // ── DRAFT authoring writes ─────────────────────────────────────────────────

  async createDraft(input: { tenant_id: string; subject: string; created_by: string }) {
    return this.repo.createEnvelope({
      tenant_id: input.tenant_id,
      subject: input.subject,
      execution_mode: 'SINGLE_SIGNATURE',
      created_by: input.created_by,
    });
  }

  // Locks the envelope row and asserts DRAFT inside the caller's transaction. An
  // envelope holding a CORE_REF (ATS/Core) document is outside the sender
  // workspace and reads as not found.
  private async assertDraft(tx: Pick<PrismaService, '$queryRaw'>, tenant_id: string, envelope_id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT e.status FROM esign."SignatureEnvelope" e
      WHERE e.id = ${envelope_id}::uuid AND e.tenant_id = ${tenant_id}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM esign."EnvelopeDocument" d
          WHERE d.envelope_id = e.id AND d.source_mode = 'CORE_REF'
        )
      FOR UPDATE OF e`;
    const row = rows[0];
    if (row === undefined) throw new EnvelopeNotFoundError(envelope_id);
    if (row.status !== 'DRAFT') throw new EnvelopeIllegalTransitionError(row.status, 'edit(DRAFT-only)');
  }

  async updateDraft(input: { tenant_id: string; envelope_id: string; subject?: string; execution_mode?: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      await tx.signatureEnvelope.update({
        where: { id: input.envelope_id },
        data: {
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.execution_mode !== undefined ? { execution_mode: input.execution_mode } : {}),
        },
      });
    });
  }

  async addDraftDocument(input: {
    tenant_id: string;
    envelope_id: string;
    actor_ref: string;
    title: string;
    source_object_key: string;
    content_type: string;
    byte_size: number;
    source_sha256: string;
  }): Promise<SenderDocumentRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const last = await tx.envelopeDocument.findFirst({
        where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id },
        orderBy: { ordinal: 'desc' },
        select: { ordinal: true },
      });
      const row = await tx.envelopeDocument.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenant_id,
          envelope_id: input.envelope_id,
          source_mode: 'OWNED',
          source_object_key: input.source_object_key,
          content_type: input.content_type,
          byte_size: input.byte_size,
          title: input.title,
          source_sha256: input.source_sha256,
          ordinal: (last?.ordinal ?? -1) + 1,
        },
      });
      await this.repo.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        event_type: 'DOCUMENT_ATTACHED',
        actor_type: 'SERVICE',
        actor_ref: input.actor_ref,
        payload: { envelope_document_id: row.id, title: row.title },
      });
      return row;
    });
  }

  async renameDraftDocument(input: { tenant_id: string; envelope_id: string; document_id: string; title: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const n = await tx.envelopeDocument.updateMany({
        where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id, id: input.document_id },
        data: { title: input.title },
      });
      if (n.count === 0) throw new EnvelopeNotFoundError(`${input.envelope_id}/${input.document_id}`);
    });
  }

  // Applies a full ordering (document ids, first = ordinal 0). Every document of
  // the envelope must appear exactly once.
  async reorderDraftDocuments(input: { tenant_id: string; envelope_id: string; order: readonly string[] }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const ids = new Set(docs.map((d) => d.id));
      if (input.order.length !== ids.size || new Set(input.order).size !== ids.size || input.order.some((id) => !ids.has(id))) {
        throw new EnvelopeIllegalTransitionError('DRAFT', 'reorder(order must list every document once)');
      }
      // Two passes avoid colliding on any future (envelope, ordinal) uniqueness.
      for (let i = 0; i < input.order.length; i += 1) {
        await tx.envelopeDocument.update({ where: { id: input.order[i] }, data: { ordinal: 1000 + i } });
      }
      for (let i = 0; i < input.order.length; i += 1) {
        await tx.envelopeDocument.update({ where: { id: input.order[i] }, data: { ordinal: i } });
      }
    });
  }

  // Removes a draft document and its fields. Returns the removed object key so the
  // caller may clean up storage (the key is never exposed to the browser).
  async removeDraftDocument(input: { tenant_id: string; envelope_id: string; document_id: string; actor_ref: string }): Promise<{ source_object_key: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const doc = await tx.envelopeDocument.findFirst({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id, id: input.document_id } });
      if (doc === null) throw new EnvelopeNotFoundError(`${input.envelope_id}/${input.document_id}`);
      await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, envelope_document_id: doc.id } });
      await tx.envelopeDocument.delete({ where: { id: doc.id } });
      const rest = await tx.envelopeDocument.findMany({
        where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id },
        orderBy: { ordinal: 'asc' },
        select: { id: true },
      });
      for (const [i, d] of rest.entries()) {
        await tx.envelopeDocument.update({ where: { id: d.id }, data: { ordinal: i } });
      }
      await this.repo.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        event_type: 'DOCUMENT_REMOVED',
        actor_type: 'SERVICE',
        actor_ref: input.actor_ref,
        payload: { envelope_document_id: doc.id, title: doc.title },
      });
      return { source_object_key: doc.source_object_key };
    });
  }

  // Replaces the recipient list: keeps (and updates) listed existing ids, creates
  // new ones, deletes the rest together with their fields. Signing order follows
  // list position (all recipients sign in parallel in V1).
  async replaceDraftRecipients(input: { tenant_id: string; envelope_id: string; recipients: readonly SenderRecipientInput[] }) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const existing = await tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const keep = new Set(input.recipients.map((r) => r.id).filter((id): id is string => id !== undefined));
      const existingIds = new Set(existing.map((s) => s.id));
      for (const id of keep) {
        if (!existingIds.has(id)) throw new EnvelopeNotFoundError(`signer ${id}`);
      }
      const removed = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
      if (removed.length > 0) {
        await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, signer_id: { in: removed } } });
        await tx.signer.deleteMany({ where: { tenant_id: input.tenant_id, id: { in: removed } } });
      }
      for (const [i, r] of input.recipients.entries()) {
        if (r.id !== undefined) {
          await tx.signer.update({ where: { id: r.id }, data: { name: r.name, email: r.email, signing_order: i + 1 } });
        } else {
          await tx.signer.create({
            data: {
              id: randomUUID(),
              tenant_id: input.tenant_id,
              envelope_id: input.envelope_id,
              name: r.name,
              email: r.email,
              signing_order: i + 1,
              signer_role: null,
              status: 'PENDING',
            },
          });
        }
      }
      return tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, orderBy: { signing_order: 'asc' } });
    });
  }

  // Replaces every field of the envelope. Documents and signers must belong to it.
  async replaceDraftFields(input: { tenant_id: string; envelope_id: string; fields: readonly SenderFieldInput[] }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const signers = await tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const docIds = new Set(docs.map((d) => d.id));
      const signerIds = new Set(signers.map((s) => s.id));
      for (const f of input.fields) {
        if (!docIds.has(f.envelope_document_id)) throw new EnvelopeNotFoundError(`document ${f.envelope_document_id}`);
        if (!signerIds.has(f.signer_id)) throw new EnvelopeNotFoundError(`signer ${f.signer_id}`);
      }
      if (docIds.size > 0) {
        await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, envelope_document_id: { in: [...docIds] } } });
      }
      for (const f of input.fields) {
        await tx.signatureField.create({
          data: {
            id: randomUUID(),
            tenant_id: input.tenant_id,
            envelope_document_id: f.envelope_document_id,
            signer_id: f.signer_id,
            field_type: f.field_type,
            page_number: f.page_number,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            required: f.required,
          },
        });
      }
      return input.fields.length;
    });
  }
}

export type { Db as SenderWorkspaceDb };
