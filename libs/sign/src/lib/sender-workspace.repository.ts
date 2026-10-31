import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { EnvelopeIllegalTransitionError, EnvelopeNotFoundError, SenderFieldPassthroughRefusedError } from './domain/errors.js';
import { EnvelopeRevisionMismatchError } from './domain/envelope-contract-errors.js';
import { SIGN_REMINDER_LIMITS, reminderHistory, type ReminderHistoryEntry } from './reminder-limits.js';
import { isCopyRecipient, isSigningRecipient, recipientKindOf, signingRecipients } from './domain/recipients.js';

// PX-V1 PX-1 — the authenticated SENDER workspace reads + DRAFT authoring writes.
//
// Every query is tenant-scoped by the caller-supplied tenant_id, which the sender
// controller takes ONLY from the verified auth context (never the request body).
// Authoring writes are DRAFT-only: each runs in a transaction that locks the
// envelope row and refuses any status other than DRAFT, so a sent / terminal
// envelope can never have its documents, recipients or fields changed. Lifecycle
// transitions (send / remind / void) stay on EsignService — this repository never
// changes an envelope's status.

// Envelopes AUTHORED in Aramo Sign (no CORE_REF document). Sign Unified Product
// S-3 (directive §4.3.5 / D-5): envelope READS now cover every envelope of the
// tenant — including ATS-originated ones (RTR, offer letters) — and visibility is
// decided by the Sign permission contract in sign-service (own vs organization).
// This predicate still bounds what stays Sign-authored only: draft authoring
// (assertDraft), the uploaded-documents library and the derived contacts list
// (an ATS recipient is never offered as a Sign contact).
// DOC-TEMPLATE-LIB-1 T-5 — an envelope the Sign console started FROM A TEMPLATE holds a
// CORE_REF document (the frozen Documents revision apps/api rendered) yet is Sign-authored:
// it is recognised by its provenance (source_application 'aramo-sign'). Additive: every
// envelope the old predicate admitted is still admitted, and ATS envelopes ('aramo-ats',
// CORE_REF) stay outside.
export const SIGN_CONSOLE_APPLICATION = 'aramo-sign';
export const SENDER_AUTHORED: { OR: Array<{ source_application: string } | { documents: { none: { source_mode: string } } }> } = {
  OR: [{ source_application: SIGN_CONSOLE_APPLICATION }, { documents: { none: { source_mode: 'CORE_REF' } } }],
};

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
  // Retention and Purge directive W5 — the "Deleted" folder: only these ids, or never these ids.
  only_ids?: readonly string[];
  exclude_ids?: readonly string[];
  limit: number;
}

export interface SenderRecipientInput {
  // Existing signer id to keep (and update), or absent for a new recipient.
  id?: string;
  name: string;
  // M-A5 §3.5 — null only for an IN_PERSON_SIGNER.
  email: string | null;
  // M-A5 §1 — omitted ⇒ SIGNER (the column default; every existing caller).
  recipient_kind?: 'SIGNER' | 'IN_PERSON_SIGNER' | 'RECEIVES_COPY';
  // M-A5 §2.1 — required iff RECEIVES_COPY.
  copy_delivery?: 'ON_SEND' | 'ON_COMPLETION' | 'BOTH' | null;
  // M-A5 §4.1 — set by the service to the caller's user id (Assign to me); never
  // taken from the request body.
  bound_user_id?: string | null;
}

export interface SenderFieldInput {
  envelope_document_id: string;
  signer_id: string | null;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  required: boolean;
  // M-A6 §2 (coordinator ruling) — an engine-only field passed back unchanged: the
  // id of the stored field it must be identical to. The stored row is kept as is.
  passthrough_id?: string;
  // M-A6 §2 — Name and Checkbox configuration (absent ⇒ NULL).
  label?: string | null;
  group_key?: string | null;
  group_rule?: string | null;
  min_selected?: number | null;
  name_mode?: string | null;
}

// Amendment M-A6 §3.5 — one template role bound to a recipient. recipient_kind and
// copy_delivery are the M-A5 §1–§2 columns (owned by migration
// 20261028100000_sign_recipient_kinds); a SIGNER row has no copy_delivery.
export interface TemplateRecipientInput {
  role_key: string;
  name: string;
  email: string;
  signing_order: number;
  recipient_kind: 'SIGNER' | 'RECEIVES_COPY';
  copy_delivery?: 'ON_SEND' | 'ON_COMPLETION' | 'BOTH';
}

// A template field placed for a role (assigned to that role's signer at bind time).
export interface TemplateFieldInput {
  envelope_document_id: string;
  role_key: string;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
}

// Sign Mobile D-W6-2 — one page of a source PDF, in points (MediaBox).
export interface DocumentPageSize {
  width: number;
  height: number;
}

// Sign Mobile D-W6-3 — the subject a deleted draft's tombstone keeps.
export const DELETED_DRAFT_SUBJECT = 'Deleted draft';

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
        // Sign Mobile D-W6-3 — a deleted draft is never listed.
        deleted_at: null,
        ...(filter.statuses !== undefined && filter.statuses.length > 0 ? { status: { in: [...filter.statuses] } } : {}),
        ...(filter.created_since !== undefined ? { created_at: { gte: filter.created_since } } : {}),
        ...(filter.created_by !== undefined ? { created_by: filter.created_by } : {}),
        ...(filter.only_ids !== undefined ? { id: { in: [...filter.only_ids] } } : filter.exclude_ids !== undefined && filter.exclude_ids.length > 0 ? { id: { notIn: [...filter.exclude_ids] } } : {}),
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
        signers: { orderBy: { signing_order: 'asc' }, select: { id: true, name: true, email: true, status: true, recipient_kind: true } },
        documents: { select: { id: true } },
      },
    });
  }

  async countByStatus(tenant_id: string, created_by?: string): Promise<Record<string, number>> {
    const rows = await this.prisma.signatureEnvelope.groupBy({
      by: ['status'],
      where: { tenant_id, deleted_at: null, ...(created_by !== undefined ? { created_by } : {}) },
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
      // Sign Mobile D-W6-3 — a deleted draft reads as not found.
      where: { tenant_id, id: envelope_id, deleted_at: null },
      include: {
        documents: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            title: true,
            ordinal: true,
            source_mode: true,
            content_type: true,
            byte_size: true,
            source_sha256: true,
            fields: true,
            // Sign Mobile D-W6-2 — the stored page sizes (null until computed).
            page_sizes: { select: { pages: true } },
          },
        },
        signers: { orderBy: { signing_order: 'asc' } },
      },
    });
    if (env === null) throw new EnvelopeNotFoundError(envelope_id);
    return env;
  }

  async getDocument(tenant_id: string, envelope_id: string, document_id: string) {
    const doc = await this.prisma.envelopeDocument.findFirst({ where: { tenant_id, envelope_id, id: document_id } });
    if (doc === null) throw new EnvelopeNotFoundError(`${envelope_id}/${document_id}`);
    return doc;
  }

  async listEnvelopeEvents(tenant_id: string, envelope_id: string) {
    return this.prisma.signatureEvent.findMany({
      where: { tenant_id, envelope_id },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      select: { id: true, event_type: true, actor_type: true, actor_ref: true, signer_id: true, payload: true, occurred_at: true, event_hash: true },
    });
  }

  // Tenant-wide activity (newest first), with the envelope subject.
  async listTenantEvents(tenant_id: string, limit: number, envelope_created_by?: string) {
    const events = await this.prisma.signatureEvent.findMany({
      where: {
        tenant_id,
        // Sign Mobile D-W6-3 — the history of a deleted draft is not shown.
        envelope: { deleted_at: null, ...(envelope_created_by !== undefined ? { created_by: envelope_created_by } : {}) },
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
      where: { tenant_id, source_mode: 'OWNED', envelope: { ...SENDER_AUTHORED, deleted_at: null, ...(created_by !== undefined ? { created_by } : {}) } },
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
  // Sign Mobile M-A3 §5 — `created_by` keeps the list to the caller's own
  // envelopes unless they may read the whole organization (the visibility rule).
  async listPastRecipients(tenant_id: string, limit: number, created_by?: string) {
    // M-A5 §3.5 — an in-person signer without an email is never a contact.
    return this.prisma.signer.findMany({
      where: { tenant_id, email: { not: null }, envelope: { ...SENDER_AUTHORED, deleted_at: null, ...(created_by !== undefined ? { created_by } : {}) } },
      orderBy: [{ envelope: { created_at: 'desc' } }],
      take: limit * 4,
      select: { name: true, email: true, envelope: { select: { id: true, created_at: true } } },
    });
  }

  // Sign Mobile M-A3 §7 — the reminder history the limits count (for the detail's
  // per-recipient reminder_available_at; the enforcing read is under the lock).
  reminderHistory(tenant_id: string, envelope_id: string, now: Date): Promise<ReminderHistoryEntry[]> {
    return reminderHistory(this.prisma, tenant_id, envelope_id, now, SIGN_REMINDER_LIMITS);
  }

  // ── DRAFT authoring writes ─────────────────────────────────────────────────

  async createDraft(input: { tenant_id: string; subject: string; created_by: string; template_ref?: string; template_version_ref?: string }) {
    return this.repo.createEnvelope({
      tenant_id: input.tenant_id,
      subject: input.subject,
      execution_mode: 'SINGLE_SIGNATURE',
      created_by: input.created_by,
      source_application: 'aramo-sign',
      // M-A6 §3.6 — a from-template draft records the template + exact version (written once).
      ...(input.template_ref !== undefined && input.template_version_ref !== undefined
        ? { template_ref: input.template_ref, template_version_ref: input.template_version_ref }
        : {}),
    });
  }

  // Amendment M-A6 §3.5 — bind a from-template draft in ONE transaction: the routing
  // mode, the message, one recipient per template role (Signer.signer_role = role_key,
  // signing_order = role order) and the template's fields assigned to their role's
  // signer. This is the INTERNAL path: the template's field types are written as the
  // template defines them (the engine's DB CHECK still applies), never limited by the
  // public authoring whitelist. Copy recipients (template CC roles) carry the M-A5
  // recipient_kind / copy_delivery columns and never get fields. Replaces any recipients
  // and fields the draft has (a fresh draft has none).
  async bindTemplateDraft(input: {
    tenant_id: string;
    envelope_id: string;
    routing_mode: 'PARALLEL' | 'SEQUENTIAL';
    message: string | null;
    recipients: readonly TemplateRecipientInput[];
    fields: readonly TemplateFieldInput[];
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id);
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const docIds = new Set(docs.map((d) => d.id));
      if (docIds.size > 0) await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, envelope_document_id: { in: [...docIds] } } });
      await tx.signer.deleteMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id } });
      // M-A5 §1.3 — the shared helper decides who signs (copies never count).
      const signing = signingRecipients(input.recipients);
      await tx.signatureEnvelope.update({
        where: { id: input.envelope_id },
        data: {
          routing_mode: input.routing_mode,
          message: input.message,
          execution_mode: signing.length > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
        },
      });
      const byRole = new Map<string, string>();
      for (const r of input.recipients) {
        const id = randomUUID();
        const copy = isCopyRecipient(r);
        await tx.signer.create({
          data: {
            id,
            tenant_id: input.tenant_id,
            envelope_id: input.envelope_id,
            name: r.name,
            email: r.email,
            signing_order: r.signing_order,
            signer_role: r.role_key,
            status: 'PENDING',
            // M-A5 §1/§2 — a template CC role is a RECEIVES_COPY recipient with its delivery
            // timing; a template SIGNER role is a SIGNER (the column default).
            recipient_kind: recipientKindOf(r),
            copy_delivery: copy ? (r.copy_delivery ?? 'ON_COMPLETION') : null,
          },
        });
        byRole.set(r.role_key, id);
      }
      for (const f of input.fields) {
        if (!docIds.has(f.envelope_document_id)) throw new EnvelopeNotFoundError(`document ${f.envelope_document_id}`);
        const signer_id = byRole.get(f.role_key);
        const recipient = input.recipients.find((r) => r.role_key === f.role_key);
        // M-A5 §1.2 — a copy recipient never gets a field.
        if (signer_id === undefined || recipient === undefined || !isSigningRecipient(recipient)) throw new EnvelopeNotFoundError(`role ${f.role_key}`);
        await tx.signatureField.create({
          data: {
            id: randomUUID(),
            tenant_id: input.tenant_id,
            envelope_document_id: f.envelope_document_id,
            signer_id,
            field_type: f.field_type,
            page_number: f.page_number,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            required: f.required,
            // M-A6 §3.3 / §2.2 — the role's printed name is filled by Sign from the
            // signer's profile (SIGNER_PROFILE, the default name mode).
            name_mode: f.field_type === 'SIGNER_NAME' ? 'SIGNER_PROFILE' : null,
          },
        });
      }
      return tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, orderBy: { signing_order: 'asc' } });
    });
  }

  // Locks the envelope row and asserts DRAFT inside the caller's transaction. An
  // envelope holding a CORE_REF (ATS/Core) document is outside the sender
  // workspace and reads as not found — unless the Sign console itself started it from
  // a template (DOC-TEMPLATE-LIB-1 T-5: source_application 'aramo-sign').
  //
  // Sign Mobile M-A3 §6 — with `expected_revision` (the caller's If-Match) the
  // revision read UNDER this lock must match, so two writers holding the same
  // revision can never both pass. Returns the locked revision.
  private async assertDraft(tx: Pick<PrismaService, '$queryRaw'>, tenant_id: string, envelope_id: string, expected_revision?: number): Promise<number> {
    const rows = await tx.$queryRaw<{ status: string; revision: number }[]>`
      SELECT e.status, e.revision FROM sign."SignatureEnvelope" e
      WHERE e.id = ${envelope_id}::uuid AND e.tenant_id = ${tenant_id}::uuid
        AND e.deleted_at IS NULL
        AND (
          e.source_application = ${SIGN_CONSOLE_APPLICATION}
          OR NOT EXISTS (
            SELECT 1 FROM sign."EnvelopeDocument" d
            WHERE d.envelope_id = e.id AND d.source_mode = 'CORE_REF'
          )
        )
      FOR UPDATE OF e`;
    const row = rows[0];
    if (row === undefined) throw new EnvelopeNotFoundError(envelope_id);
    if (row.status !== 'DRAFT') throw new EnvelopeIllegalTransitionError(row.status, 'edit(DRAFT-only)');
    if (expected_revision !== undefined && row.revision !== expected_revision) {
      throw new EnvelopeRevisionMismatchError(envelope_id, row.revision, expected_revision);
    }
    return row.revision;
  }

  // Returns the envelope revision after the write (M-A3 §6), so a multi-step caller
  // can chain its next precondition. `message` null clears it (DRAFT only — the
  // database refuses any change once sent).
  async updateDraft(input: {
    tenant_id: string;
    envelope_id: string;
    subject?: string;
    execution_mode?: string;
    routing_mode?: string;
    message?: string | null;
    expected_revision?: number;
  }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
      await tx.signatureEnvelope.update({
        where: { id: input.envelope_id },
        data: {
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.execution_mode !== undefined ? { execution_mode: input.execution_mode } : {}),
          ...(input.routing_mode !== undefined ? { routing_mode: input.routing_mode } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
      });
      return this.repo.revisionIn(tx, input.envelope_id);
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
    expected_revision?: number;
    // Sign Mobile D-W6-2 — the page sizes the caller measured from the accepted bytes.
    pages?: readonly DocumentPageSize[];
  }): Promise<SenderDocumentRow & { revision: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
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
      if (input.pages !== undefined && input.pages.length > 0) {
        await tx.signEnvelopeDocumentPages.create({ data: { envelope_document_id: row.id, tenant_id: input.tenant_id, pages: input.pages.map((p) => ({ width: p.width, height: p.height })) } });
      }
      // Sign Mobile D-W6-1 — the revision this write produced, so the caller can
      // chain its next If-Match without re-reading the envelope.
      return { ...row, revision: await this.repo.revisionIn(tx, input.envelope_id) };
    });
  }

  // Sign Mobile D-W6-2 — record the page sizes of a document uploaded before they
  // were stored (filled on first read). Idempotent; never touches the document or
  // envelope row, so it never changes the envelope revision.
  async savePageSizes(tenant_id: string, envelope_document_id: string, pages: readonly DocumentPageSize[]): Promise<void> {
    if (pages.length === 0) return;
    await this.prisma.signEnvelopeDocumentPages.createMany({
      data: [{ envelope_document_id, tenant_id, pages: pages.map((p) => ({ width: p.width, height: p.height })) }],
      skipDuplicates: true,
    });
  }

  // Sign Mobile D-W6-3 — delete a DRAFT. Under the envelope row lock (DRAFT, not yet
  // deleted, the expected revision): its fields, documents and recipients are
  // deleted, the subject and message scrubbed, deleted_at set, and DRAFT_DELETED
  // appended to the ledger (counts only). The ledger rows themselves stay: they are
  // append-only and hold no signing evidence for a draft. Returns the OWNED source
  // object keys so the caller removes the stored bytes and releases their storage.
  async deleteDraft(input: { tenant_id: string; envelope_id: string; actor_ref: string; expected_revision?: number }): Promise<{ source_object_keys: string[]; document_count: number; recipient_count: number }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true, source_object_key: true } });
      const signers = await tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      if (docs.length > 0) {
        await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, envelope_document_id: { in: docs.map((d) => d.id) } } });
      }
      if (signers.length > 0) {
        await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, signer_id: { in: signers.map((x) => x.id) } } });
      }
      await tx.envelopeDocument.deleteMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id } });
      await tx.signer.deleteMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id } });
      await tx.signatureEnvelope.update({
        where: { id: input.envelope_id },
        data: { deleted_at: new Date(), subject: DELETED_DRAFT_SUBJECT, message: null },
      });
      await this.repo.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        event_type: 'DRAFT_DELETED',
        actor_type: 'SERVICE',
        actor_ref: input.actor_ref,
        payload: { document_count: docs.length, recipient_count: signers.length },
      });
      return {
        source_object_keys: docs.map((d) => d.source_object_key).filter((k): k is string => k !== null),
        document_count: docs.length,
        recipient_count: signers.length,
      };
    });
  }

  // DOC-TEMPLATE-LIB-1 T-5 — attach a frozen Documents revision (CORE_REF) to a Sign
  // console draft: the document apps/api rendered from a template. Sign stores only the
  // UUID references + the source hash; the bytes stay in Documents and are pulled over
  // the signed channel (DocumentSourceHttpAdapter) — never copied into Sign storage.
  async addDraftCoreRefDocument(input: {
    tenant_id: string;
    envelope_id: string;
    actor_ref: string;
    title: string;
    document_ref: string;
    document_revision_ref: string;
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
          source_mode: 'CORE_REF',
          document_ref: input.document_ref,
          document_revision_ref: input.document_revision_ref,
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

  async renameDraftDocument(input: { tenant_id: string; envelope_id: string; document_id: string; title: string; expected_revision?: number }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
      const n = await tx.envelopeDocument.updateMany({
        where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id, id: input.document_id },
        data: { title: input.title },
      });
      if (n.count === 0) throw new EnvelopeNotFoundError(`${input.envelope_id}/${input.document_id}`);
    });
  }

  // Applies a full ordering (document ids, first = ordinal 0). Every document of
  // the envelope must appear exactly once.
  async reorderDraftDocuments(input: { tenant_id: string; envelope_id: string; order: readonly string[]; expected_revision?: number }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
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
  async removeDraftDocument(input: { tenant_id: string; envelope_id: string; document_id: string; actor_ref: string; expected_revision?: number }): Promise<{ source_object_key: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
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
  // list position (1..N). Multi-Signer §6 — reorder-safe: the kept signers are first
  // parked on temporary positions beyond any final one, so rewriting the order never
  // collides with the (envelope, signing_order) unique index mid-way.
  async replaceDraftRecipients(input: { tenant_id: string; envelope_id: string; recipients: readonly SenderRecipientInput[]; expected_revision?: number }) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
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
      const PARK = 1000;
      for (const [i, r] of input.recipients.entries()) {
        if (r.id !== undefined) await tx.signer.update({ where: { id: r.id }, data: { signing_order: PARK + i + 1 } });
      }
      for (const [i, r] of input.recipients.entries()) {
        if (r.id !== undefined) {
          await tx.signer.update({ where: { id: r.id }, data: { name: r.name, email: r.email, signing_order: i + 1, ...recipientKindData(r) } });
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
              ...recipientKindData(r),
            },
          });
        }
      }
      return tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, orderBy: { signing_order: 'asc' } });
    });
  }

  // Replaces every field of the envelope. Documents and signers must belong to it.
  async replaceDraftFields(input: { tenant_id: string; envelope_id: string; fields: readonly SenderFieldInput[]; expected_revision?: number }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDraft(tx, input.tenant_id, input.envelope_id, input.expected_revision);
      const docs = await tx.envelopeDocument.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const signers = await tx.signer.findMany({ where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id }, select: { id: true } });
      const docIds = new Set(docs.map((d) => d.id));
      const signerIds = new Set(signers.map((s) => s.id));
      for (const f of input.fields) {
        if (!docIds.has(f.envelope_document_id)) throw new EnvelopeNotFoundError(`document ${f.envelope_document_id}`);
        if (f.passthrough_id === undefined && (f.signer_id === null || !signerIds.has(f.signer_id))) throw new EnvelopeNotFoundError(`signer ${f.signer_id ?? 'none'}`);
      }
      // M-A6 §2 (coordinator ruling) — an engine-only field passes through only when
      // it is byte-identical to its stored row on this envelope; that row is kept.
      const keep: string[] = [];
      for (const [index, f] of input.fields.entries()) {
        if (f.passthrough_id === undefined) continue;
        const stored = docIds.size === 0 ? null : await tx.signatureField.findFirst({
          where: { id: f.passthrough_id, tenant_id: input.tenant_id, envelope_document_id: { in: [...docIds] } },
        });
        if (stored === null || keep.includes(stored.id) || !sameField(stored, f)) throw new SenderFieldPassthroughRefusedError(index);
        keep.push(stored.id);
      }
      if (docIds.size > 0) {
        await tx.signatureField.deleteMany({ where: { tenant_id: input.tenant_id, envelope_document_id: { in: [...docIds] }, ...(keep.length > 0 ? { id: { notIn: keep } } : {}) } });
      }
      for (const f of input.fields) {
        if (f.passthrough_id !== undefined) continue;
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
            label: f.label ?? null,
            group_key: f.group_key ?? null,
            group_rule: f.group_rule ?? null,
            min_selected: f.min_selected ?? null,
            name_mode: f.name_mode ?? null,
          },
        });
      }
      return input.fields.length;
    });
  }
}

// M-A6 §2 (coordinator ruling) — identical type, recipient, document, page,
// geometry, required setting and configuration.
function sameField(
  stored: { field_type: string; signer_id: string | null; envelope_document_id: string; page_number: number; x: number; y: number; width: number | null; height: number | null; required: boolean; label: string | null; group_key: string | null; group_rule: string | null; min_selected: number | null; name_mode: string | null },
  f: SenderFieldInput,
): boolean {
  return stored.field_type === f.field_type
    && stored.signer_id === f.signer_id
    && stored.envelope_document_id === f.envelope_document_id
    && stored.page_number === f.page_number
    && stored.x === f.x
    && stored.y === f.y
    && stored.width === f.width
    && stored.height === f.height
    && stored.required === f.required
    && stored.label === (f.label ?? null)
    && stored.group_key === (f.group_key ?? null)
    && stored.group_rule === (f.group_rule ?? null)
    && stored.min_selected === (f.min_selected ?? null)
    && stored.name_mode === (f.name_mode ?? null);
}

export type { Db as SenderWorkspaceDb };

// M-A5 §1 / §2 / §4 — the recipient-kind columns a PUT recipients item writes (a
// full replacement: an omitted kind is SIGNER, an omitted binding is cleared).
function recipientKindData(r: SenderRecipientInput): { recipient_kind: string; copy_delivery: string | null; bound_user_id: string | null } {
  const kind = r.recipient_kind ?? 'SIGNER';
  return {
    recipient_kind: kind,
    copy_delivery: kind === 'RECEIVES_COPY' ? (r.copy_delivery ?? null) : null,
    bound_user_id: kind === 'RECEIVES_COPY' ? null : (r.bound_user_id ?? null),
  };
}
