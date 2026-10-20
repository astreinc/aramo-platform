import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { computeEventHash } from './hash-chain.js';
import {
  EnvelopeAlreadyExecutedError,
  EnvelopeIllegalTransitionError,
  EnvelopeNotFoundError,
  SignerNotFoundError,
} from './domain/errors.js';
import {
  LIVE_SESSION_STATUSES,
  isTerminalEnvelopeStatus,
  predecessorsOf,
} from './domain/envelope-lifecycle.js';
import { type EnvelopeDocumentSourceMode } from './ports/document-source-provider.port.js';

// DOC-3 boundary 1-2 — E-Sign persistence + append-only hash-chained event
// ledger. ATS-neutral: Documents referenced by opaque UUID only. Any Prisma tx
// client works for the transactional helpers.

type Tx = Pick<PrismaService, 'signatureEnvelope' | 'signer' | 'signatureField' | 'signatureEvent' | 'envelopeDocument' | 'signingSession' | 'signerDisclosureAcceptance' | 'outboxEvent' | 'idempotencyKey'>;

// ES-1 — an interactive-transaction client that can also take a row lock.
export type LockingTx = Tx & Pick<PrismaService, '$queryRaw'>;

export interface TransitionEnvelopeInput {
  tenant_id: string;
  envelope_id: string;
  to: string;
  event_type: string;
  actor_type: string;
  actor_ref?: string;
  timestampField?: 'sent_at' | 'completed_at' | 'declined_at' | 'voided_at';
  payload?: unknown;
}

export interface CreateEnvelopeInput {
  tenant_id: string;
  subject: string;
  execution_mode: string;
  created_by: string;
  // Sign Unified Product S-1 — provenance. Omitted ⇒ the column defaults
  // ('aramo-sign', no installation, USER).
  source_application?: string;
  installation_id?: string | null;
  origin_actor_kind?: 'USER' | 'APPLICATION';
}

// PX-V1 F1 — CORE_REF (legacy ATS: document_ref/document_revision_ref) OR OWNED
// (standalone: source_object_key + content_type/byte_size). source_mode defaults
// to CORE_REF so every existing caller is unchanged.
export interface AddDocumentInput {
  tenant_id: string;
  envelope_id: string;
  source_mode?: EnvelopeDocumentSourceMode;
  document_ref?: string | null;
  document_revision_ref?: string | null;
  source_object_key?: string | null;
  content_type?: string | null;
  byte_size?: number | null;
  title: string;
  source_sha256: string;
  ordinal: number;
}

export interface AddSignerInput {
  tenant_id: string;
  envelope_id: string;
  email: string;
  name: string;
  signing_order: number;
  signer_role?: string;
}

export interface AddFieldInput {
  tenant_id: string;
  envelope_document_id: string;
  signer_id?: string;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  required?: boolean;
}

export interface AppendEventInput {
  tenant_id: string;
  envelope_id: string;
  signer_id?: string;
  event_type: string;
  actor_type: string; // SIGNER|SYSTEM|SERVICE
  actor_ref?: string;
  payload?: unknown;
  ip_address?: string;
  user_agent?: string;
}

@Injectable()
export class EsignRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Append-only hash-chained event (R20/§256). Reads the current terminal
  // event for the envelope and chains from it. Call once per operation. ──
  async appendEvent(tx: Tx, input: AppendEventInput): Promise<string> {
    const prev = await tx.signatureEvent.findFirst({
      where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      select: { event_hash: true },
    });
    const occurredAt = new Date();
    const previousHash = prev?.event_hash ?? null;
    const eventHash = computeEventHash(previousHash, {
      envelope_id: input.envelope_id,
      event_type: input.event_type,
      actor_type: input.actor_type,
      actor_ref: input.actor_ref ?? null,
      payload: input.payload ?? null,
      occurred_at: occurredAt.toISOString(),
    });
    const id = randomUUID();
    await tx.signatureEvent.create({
      data: {
        id,
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        signer_id: input.signer_id ?? null,
        event_type: input.event_type,
        actor_type: input.actor_type,
        actor_ref: input.actor_ref ?? null,
        payload: (input.payload ?? undefined) as never,
        previous_event_hash: previousHash,
        event_hash: eventHash,
        occurred_at: occurredAt,
        ip_address: input.ip_address ?? null,
        user_agent: input.user_agent ?? null,
      },
    });
    return eventHash;
  }

  async createEnvelope(input: CreateEnvelopeInput) {
    const id = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const env = await tx.signatureEnvelope.create({
        data: {
          id,
          tenant_id: input.tenant_id,
          subject: input.subject,
          status: 'DRAFT',
          execution_mode: input.execution_mode,
          created_by: input.created_by,
          ...(input.source_application !== undefined ? { source_application: input.source_application } : {}),
          ...(input.installation_id !== undefined && input.installation_id !== null ? { installation_id: input.installation_id } : {}),
          ...(input.origin_actor_kind !== undefined ? { origin_actor_kind: input.origin_actor_kind } : {}),
        },
      });
      await this.appendEvent(tx, {
        tenant_id: input.tenant_id,
        envelope_id: id,
        event_type: 'ENVELOPE_CREATED',
        actor_type: 'SERVICE',
        actor_ref: input.created_by,
        payload: { execution_mode: input.execution_mode },
      });
      return env;
    });
  }

  async getEnvelope(tenant_id: string, id: string) {
    const env = await this.prisma.signatureEnvelope.findFirst({ where: { tenant_id, id } });
    if (env === null) throw new EnvelopeNotFoundError(id);
    return env;
  }

  async getEnvelopeFull(tenant_id: string, id: string) {
    const env = await this.prisma.signatureEnvelope.findFirst({
      where: { tenant_id, id },
      include: {
        documents: { orderBy: { ordinal: 'asc' }, include: { fields: true } },
        signers: { orderBy: { signing_order: 'asc' } },
      },
    });
    if (env === null) throw new EnvelopeNotFoundError(id);
    return env;
  }

  async addDocument(input: AddDocumentInput) {
    await this.getEnvelope(input.tenant_id, input.envelope_id);
    return this.prisma.envelopeDocument.create({ data: { id: randomUUID(), ...input } });
  }

  async addSigner(input: AddSignerInput) {
    await this.getEnvelope(input.tenant_id, input.envelope_id);
    return this.prisma.signer.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        email: input.email,
        name: input.name,
        signing_order: input.signing_order,
        signer_role: input.signer_role ?? null,
        status: 'PENDING',
      },
    });
  }

  async getSigner(tenant_id: string, id: string) {
    const s = await this.prisma.signer.findFirst({ where: { tenant_id, id } });
    if (s === null) throw new SignerNotFoundError(id);
    return s;
  }

  async addField(input: AddFieldInput) {
    return this.prisma.signatureField.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        envelope_document_id: input.envelope_document_id,
        signer_id: input.signer_id ?? null,
        field_type: input.field_type,
        page_number: input.page_number,
        x: input.x,
        y: input.y,
        width: input.width ?? null,
        height: input.height ?? null,
        required: input.required ?? true,
      },
    });
  }

  async listSignerRequiredFields(tenant_id: string, signer_id: string) {
    return this.prisma.signatureField.findMany({ where: { tenant_id, signer_id, required: true } });
  }

  // ES-1 — transactional envelope status change + single hash-chained event.
  // The status write is a COMPARE-AND-SET against the lifecycle predecessors of
  // `to`: `UPDATE … WHERE status IN (predecessors)` takes the row lock and
  // re-checks the predicate atomically, so of two racing transitions exactly one
  // matches and the other fails with EnvelopeIllegalTransitionError (its
  // transaction rolls back). Entering a terminal state revokes every live signing
  // session of the envelope in the SAME transaction.
  async transitionEnvelope(input: TransitionEnvelopeInput) {
    return this.prisma.$transaction((tx) => this.transitionEnvelopeIn(tx, input));
  }

  async transitionEnvelopeIn(tx: Tx, input: TransitionEnvelopeInput) {
    const now = new Date();
    const data: Record<string, unknown> = { status: input.to };
    if (input.timestampField) data[input.timestampField] = now;
    const won = await tx.signatureEnvelope.updateMany({
      where: { id: input.envelope_id, tenant_id: input.tenant_id, status: { in: predecessorsOf(input.to) } },
      data,
    });
    if (won.count !== 1) {
      const current = await tx.signatureEnvelope.findFirst({
        where: { id: input.envelope_id, tenant_id: input.tenant_id },
        select: { status: true },
      });
      if (current === null) throw new EnvelopeNotFoundError(input.envelope_id);
      throw new EnvelopeIllegalTransitionError(current.status, input.to);
    }
    if (isTerminalEnvelopeStatus(input.to)) {
      await tx.signingSession.updateMany({
        where: { tenant_id: input.tenant_id, envelope_id: input.envelope_id, status: { in: [...LIVE_SESSION_STATUSES] } },
        data: { status: 'REVOKED', revoked_at: now },
      });
    }
    await this.appendEvent(tx, {
      tenant_id: input.tenant_id,
      envelope_id: input.envelope_id,
      event_type: input.event_type,
      actor_type: input.actor_type,
      actor_ref: input.actor_ref,
      payload: input.payload,
    });
    return tx.signatureEnvelope.findFirstOrThrow({ where: { id: input.envelope_id, tenant_id: input.tenant_id } });
  }

  // ES-1 — take the envelope row lock (SELECT … FOR UPDATE) for the rest of the
  // transaction and return the status read UNDER that lock. Every signer-side
  // mutation and every status change locks the same row, so they serialize per
  // envelope: a signer action can never interleave with void / decline / expiry
  // / completion, and the hash-chained events it appends stay linear.
  async lockEnvelope(tx: LockingTx, tenant_id: string, envelope_id: string): Promise<string> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "sign"."SignatureEnvelope"
      WHERE id = ${envelope_id}::uuid AND tenant_id = ${tenant_id}::uuid
      FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) throw new EnvelopeNotFoundError(envelope_id);
    return row.status;
  }

  // ES-1 — lock the envelope and require that a signer may still act on it.
  // Terminal → EnvelopeAlreadyExecutedError(status); any other non-signable
  // status (DRAFT) → EnvelopeIllegalTransitionError.
  async lockSignableEnvelope(tx: LockingTx, tenant_id: string, envelope_id: string): Promise<'SENT' | 'IN_PROGRESS'> {
    const status = await this.lockEnvelope(tx, tenant_id, envelope_id);
    if (status === 'SENT' || status === 'IN_PROGRESS') return status;
    if (isTerminalEnvelopeStatus(status)) throw new EnvelopeAlreadyExecutedError(envelope_id, status);
    throw new EnvelopeIllegalTransitionError(status, 'SIGN');
  }

  async listEvents(tenant_id: string, envelope_id: string) {
    await this.getEnvelope(tenant_id, envelope_id);
    return this.prisma.signatureEvent.findMany({
      where: { tenant_id, envelope_id },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    });
  }

  async terminalEventHash(tenant_id: string, envelope_id: string): Promise<string | null> {
    const last = await this.prisma.signatureEvent.findFirst({
      where: { tenant_id, envelope_id },
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      select: { event_hash: true },
    });
    return last?.event_hash ?? null;
  }

  // DOC-4 (R-4-7) — executed artifacts for the write-back pull. Each executed
  // document is joined to its EnvelopeDocument for the Documents refs.
  async listExecutedDocuments(tenant_id: string, envelope_id: string) {
    const rows = await this.prisma.executedDocument.findMany({ where: { tenant_id, envelope_id } });
    const docs = await this.prisma.envelopeDocument.findMany({ where: { envelope_id } });
    const byId = new Map(docs.map((d) => [d.id, d]));
    return rows.map((r) => ({
      envelope_document_id: r.envelope_document_id,
      document_ref: byId.get(r.envelope_document_id)?.document_ref ?? null,
      document_revision_ref: byId.get(r.envelope_document_id)?.document_revision_ref ?? null,
      executed_sha256: r.executed_sha256,
      byte_size: r.byte_size,
      executed_bytes: r.executed_bytes,
    }));
  }

  async getExecutionCertificate(tenant_id: string, envelope_id: string) {
    return this.prisma.executionCertificate.findFirst({ where: { tenant_id, envelope_id } });
  }

  // COMM-RECRUITER-W1 (W1-C1) — reverse-resolve the NON-TERMINAL envelope(s) for a
  // document revision. E-Sign owns envelope identity; this is the sole seam
  // Documents/RTR use to find an envelope from (tenant, document_ref,
  // document_revision_ref). Tenant-scoped; exact refs; terminal envelopes
  // (COMPLETED/DECLINED/VOIDED/EXPIRED) are excluded so historical envelopes may
  // coexist without ambiguity. Deterministic order (created_at, id) — the SERVICE
  // enforces the 0/1/>1 rule (it never picks "latest").
  async findNonTerminalEnvelopesByDocument(
    tenant_id: string,
    document_ref: string,
    document_revision_ref: string,
  ): Promise<{ id: string; status: string }[]> {
    const rows = await this.prisma.signatureEnvelope.findMany({
      where: {
        tenant_id,
        status: { in: ['DRAFT', 'SENT', 'IN_PROGRESS'] },
        documents: { some: { tenant_id, document_ref, document_revision_ref } },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true },
    });
    return rows.map((r) => ({ id: r.id, status: r.status }));
  }

  // COMM-RECRUITER-W1 (W1-C2) — record a notification delivery attempt (the first
  // code path to write NotificationDelivery). status=SENT|FAILED|PENDING;
  // last_error is set on FAILED. One row per dispatch attempt.
  async recordNotificationDelivery(input: {
    tenant_id: string;
    envelope_id: string;
    signer_id?: string | null;
    notification_kind: string;
    status: string;
    last_error?: string | null;
  }): Promise<void> {
    await this.prisma.notificationDelivery.create({
      data: {
        id: randomUUID(),
        tenant_id: input.tenant_id,
        envelope_id: input.envelope_id,
        signer_id: input.signer_id ?? null,
        notification_kind: input.notification_kind,
        status: input.status,
        attempts: 1,
        last_error: input.last_error ?? null,
        sent_at: input.status === 'SENT' ? new Date() : null,
      },
    });
  }
}
