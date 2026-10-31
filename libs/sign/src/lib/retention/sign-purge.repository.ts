import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { EsignRepository } from '../esign.repository.js';
import { computeEventHash } from '../hash-chain.js';
import { OutboxService } from '../outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SIGN_ENVELOPE_PURGE_EVENT_TYPE,
  type EsignPurgeReason,
  type EsignPurgeState,
} from '../ports/event-publisher.port.js';

// Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (ebd41d99) — the
// database side of DocuSign-parity retention and purge (W1, W3, W4, W5, W6).
//
//   Setting   one row per tenant: retention_days NULL = keep forever (R-3), else 1..9999
//             days after the envelope reached COMPLETED / DECLINED / VOIDED (R-4, R-5),
//             and the purge level the retention purge applies. Every change is appended
//             to SignTenantRetentionPolicyEvent (actor, old, new).
//   Queue     an eligible envelope is QUEUED with purge_due_at = now + 14 days (R-7);
//             DEQUEUED cancels it before it executes. A retention run never re-queues an
//             envelope an administrator dequeued.
//   Execute   one transaction, under the envelope row lock, only while the purge is QUEUED
//             and due and the tenant is not under Aramo legal hold (R-12): artifact bytes to
//             NULL (rows, hashes and custody records stay), page cache removed, metadata and
//             personal data cleared per level, ledger events redacted per LD-2, then one
//             ENVELOPE_PURGED ledger event and the envelope marked EXECUTED (final).
//             The S3 objects are removed by the caller BEFORE this transaction.
//   Delete    the DocuSign "Deleted" folder: hidden for one party only (W5, LD-5).
//
// Every state change appends a ledger event and enqueues sign.envelope.purge.v1 in the same
// transaction. The database guards (migration 20261101100000) admit the purge writes only
// inside the due window, so a bug here cannot purge early.

export type PurgeLevel = 'DOCUMENTS' | 'DOCUMENTS_AND_METADATA' | 'DOCUMENTS_AND_METADATA_AND_REDACT';
export const PURGE_LEVELS: readonly PurgeLevel[] = ['DOCUMENTS', 'DOCUMENTS_AND_METADATA', 'DOCUMENTS_AND_METADATA_AND_REDACT'];
export const PURGE_ELIGIBLE_STATUSES: readonly string[] = ['COMPLETED', 'DECLINED', 'VOIDED'];
export const PURGE_QUEUE_DAYS = 14;
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 9999;
export const PURGED_TEXT = '[purged]';
export const REDACTED_TEXT = '[redacted]';
export const REDACTED_PAYLOAD_VALUE = '[REDACTED]';
// Ledger payload keys that can carry personal data (LD-2). Every other key is an id,
// hash, size, version or enum and is kept.
export const PII_PAYLOAD_KEYS: readonly string[] = ['title', 'reason', 'name', 'email', 'attested_name', 'subject', 'message', 'decline_reason'];

export const PURGE_QUEUED_EVENT = 'ENVELOPE_PURGE_QUEUED';
export const PURGE_DEQUEUED_EVENT = 'ENVELOPE_PURGE_DEQUEUED';
export const PURGED_EVENT = 'ENVELOPE_PURGED';
export const PARTY_DELETED_EVENT = 'ENVELOPE_DELETED_BY_PARTY';
export const PARTY_RESTORED_EVENT = 'ENVELOPE_RESTORED_BY_PARTY';

const DAY_MS = 86_400_000;
const LEVEL_RANK: Record<PurgeLevel, number> = { DOCUMENTS: 1, DOCUMENTS_AND_METADATA: 2, DOCUMENTS_AND_METADATA_AND_REDACT: 3 };
const NOT_HELD = (alias: string) => `NOT EXISTS (SELECT 1 FROM identity."Tenant" h WHERE h.id = ${alias}.tenant_id AND h.legal_hold = true)`;

export function isPurgeLevel(v: unknown): v is PurgeLevel {
  return typeof v === 'string' && (PURGE_LEVELS as readonly string[]).includes(v);
}

/** DocuSign purgeState string for a queued level, a dequeue, or an execution. */
export function purgeStateFor(state: 'QUEUED' | 'DEQUEUED' | 'EXECUTED', level: PurgeLevel): EsignPurgeState {
  if (state === 'DEQUEUED') return 'documents_dequeued';
  if (state === 'EXECUTED') return 'executed';
  if (level === 'DOCUMENTS') return 'documents_queued';
  if (level === 'DOCUMENTS_AND_METADATA') return 'documents_and_metadata_queued';
  return 'documents_and_metadata_and_redact_queued';
}

export interface RetentionPolicy {
  tenant_id: string;
  retention_days: number | null;
  purge_level: PurgeLevel;
  updated_at: Date | null;
  updated_by: string | null;
}

export interface EnvelopePurgeStatus {
  state: 'QUEUED' | 'DEQUEUED' | 'EXECUTED';
  level: PurgeLevel;
  reason: EsignPurgeReason;
  queued_at: Date;
  due_at: Date;
  waiting_until: Date | null;
  executed_at: Date | null;
}

export type QueueOutcome = 'queued' | 'upgraded' | 'already_queued' | 'not_eligible' | 'executed' | 'dequeued_by_admin';

export interface DueEnvelope {
  tenant_id: string;
  envelope_id: string;
  level: PurgeLevel;
  reason: EsignPurgeReason;
}

export interface PurgeObjectsReport {
  deleted: number;
  locked: Array<{ key: string; retain_until: Date }>;
}

export type ExecuteOutcome =
  | { status: 'executed'; level: PurgeLevel; documents: number; certificates: number; events_redacted: number }
  | { status: 'held' } // tenant under Aramo legal hold (R-12): stays queued
  | { status: 'not_due' }; // dequeued, already executed, or not yet due

interface EnvelopeRow {
  id: string;
  tenant_id: string;
  status: string;
  deleted_at: Date | null;
  purge_state: string | null;
  purge_level: string | null;
  purge_reason: string | null;
  purge_queued_at: Date | null;
  purge_due_at: Date | null;
  purge_waiting_until: Date | null;
  purge_executed_at: Date | null;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class SignPurgeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    private readonly outbox: OutboxService,
  ) {}

  // ── W1: the tenant setting ────────────────────────────────────────────────

  async getPolicy(tenant_id: string): Promise<RetentionPolicy> {
    const row = await this.prisma.signTenantRetentionPolicy.findUnique({ where: { tenant_id } });
    if (row === null) return { tenant_id, retention_days: null, purge_level: 'DOCUMENTS', updated_at: null, updated_by: null };
    return { tenant_id, retention_days: row.retention_days, purge_level: isPurgeLevel(row.purge_level) ? row.purge_level : 'DOCUMENTS', updated_at: row.updated_at, updated_by: row.updated_by };
  }

  /** Upserts the setting and appends the change (actor, old, new) in one transaction. */
  async setPolicy(tenant_id: string, input: { retention_days: number | null; purge_level: PurgeLevel }, actor_user_id: string): Promise<RetentionPolicy> {
    if (input.retention_days !== null && (!Number.isInteger(input.retention_days) || input.retention_days < RETENTION_DAYS_MIN || input.retention_days > RETENTION_DAYS_MAX)) {
      throw new RangeError(`retention_days must be null or an integer ${RETENTION_DAYS_MIN}..${RETENTION_DAYS_MAX}`);
    }
    if (!isPurgeLevel(input.purge_level)) throw new RangeError('unknown purge_level');
    return this.prisma.$transaction(async (tx) => {
      const old = await tx.signTenantRetentionPolicy.findUnique({ where: { tenant_id } });
      const now = new Date();
      const row = await tx.signTenantRetentionPolicy.upsert({
        where: { tenant_id },
        create: { tenant_id, retention_days: input.retention_days, purge_level: input.purge_level, updated_by: actor_user_id, updated_at: now },
        update: { retention_days: input.retention_days, purge_level: input.purge_level, updated_by: actor_user_id, updated_at: now },
      });
      await tx.signTenantRetentionPolicyEvent.create({
        data: {
          id: randomUUID(),
          tenant_id,
          actor_user_id,
          old_retention_days: old?.retention_days ?? null,
          new_retention_days: input.retention_days,
          old_purge_level: old?.purge_level ?? null,
          new_purge_level: input.purge_level,
          changed_at: now,
        },
      });
      return { tenant_id, retention_days: row.retention_days, purge_level: input.purge_level, updated_at: row.updated_at, updated_by: row.updated_by };
    });
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async status(tenant_id: string, envelope_id: string): Promise<EnvelopePurgeStatus | null> {
    const e = await this.prisma.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: PURGE_SELECT });
    return e === null ? null : toStatus(e as unknown as EnvelopeRow);
  }

  // ── W4: queue / dequeue ───────────────────────────────────────────────────

  /**
   * Queues one envelope for purge (R-7: 14-day queue). A higher level upgrades an
   * envelope already queued; an executed purge is final; only a non-retention request
   * re-queues an envelope an administrator dequeued.
   */
  async queue(
    tenant_id: string,
    envelope_id: string,
    input: { level: PurgeLevel; reason: EsignPurgeReason; actor_user_id?: string | null; now?: Date },
  ): Promise<QueueOutcome> {
    const now = input.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as never, tenant_id, envelope_id);
      const e = await this.envelopeRow(tx, tenant_id, envelope_id);
      if (e === null || !PURGE_ELIGIBLE_STATUSES.includes(e.status) || e.deleted_at !== null) return 'not_eligible';
      if (e.purge_state === 'EXECUTED') return 'executed';
      if (e.purge_state === 'DEQUEUED' && input.reason === 'retention') return 'dequeued_by_admin';
      if (e.purge_state === 'QUEUED') {
        const current = e.purge_level as PurgeLevel;
        if (LEVEL_RANK[input.level] <= LEVEL_RANK[current]) return 'already_queued';
        await tx.signatureEnvelope.update({ where: { id: envelope_id }, data: { purge_level: input.level } });
        await this.recordTransition(tx, tenant_id, envelope_id, PURGE_QUEUED_EVENT, 'QUEUED', input.level, (e.purge_reason as EsignPurgeReason) ?? input.reason, e.purge_due_at, input.actor_user_id ?? null, { upgraded_from: current });
        return 'upgraded';
      }
      const due = new Date(now.getTime() + PURGE_QUEUE_DAYS * DAY_MS);
      await tx.signatureEnvelope.update({
        where: { id: envelope_id },
        data: {
          purge_state: 'QUEUED',
          purge_level: input.level,
          purge_reason: input.reason,
          purge_requested_by: input.actor_user_id ?? null,
          purge_queued_at: now,
          purge_due_at: due,
          purge_waiting_until: null,
        },
      });
      await this.recordTransition(tx, tenant_id, envelope_id, PURGE_QUEUED_EVENT, 'QUEUED', input.level, input.reason, due, input.actor_user_id ?? null);
      return 'queued';
    });
  }

  /** Cancels a queued purge before it executes (DocuSign documents_dequeued). */
  async dequeue(tenant_id: string, envelope_id: string, actor_user_id: string): Promise<'dequeued' | 'not_queued'> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as never, tenant_id, envelope_id);
      const e = await this.envelopeRow(tx, tenant_id, envelope_id);
      if (e === null || e.purge_state !== 'QUEUED') return 'not_queued';
      await tx.signatureEnvelope.update({ where: { id: envelope_id }, data: { purge_state: 'DEQUEUED', purge_waiting_until: null } });
      await this.recordTransition(tx, tenant_id, envelope_id, PURGE_DEQUEUED_EVENT, 'DEQUEUED', e.purge_level as PurgeLevel, e.purge_reason as EsignPurgeReason, null, actor_user_id);
      return 'dequeued';
    });
  }

  // ── W4: selection (bounded batches, oldest first) ─────────────────────────

  /** Terminal envelopes past their tenant's retention period, not yet queued, not held. */
  async retentionDue(now: Date, limit: number): Promise<Array<{ tenant_id: string; envelope_id: string; level: PurgeLevel }>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; envelope_id: string; level: string }>>(
      `SELECT e.tenant_id::text AS tenant_id, e.id::text AS envelope_id, p.purge_level AS level
         FROM "sign"."SignatureEnvelope" e
         JOIN "sign"."SignTenantRetentionPolicy" p ON p.tenant_id = e.tenant_id
        WHERE p.retention_days IS NOT NULL
          AND e.status IN ('COMPLETED', 'DECLINED', 'VOIDED')
          AND e.purge_state IS NULL
          AND e.deleted_at IS NULL
          AND COALESCE(e.completed_at, e.declined_at, e.voided_at) + make_interval(days => p.retention_days) <= $1
          AND ${NOT_HELD('e')}
        ORDER BY COALESCE(e.completed_at, e.declined_at, e.voided_at) ASC
        LIMIT $2`,
      now,
      limit,
    );
    return rows.map((r) => ({ ...r, level: isPurgeLevel(r.level) ? r.level : 'DOCUMENTS' }));
  }

  /**
   * Terminal envelopes every party has deleted (R-10): the sending tenant's SENDER row is
   * active and every active recipient binding's user has an active RECIPIENT row.
   */
  async allPartiesDeletedDue(limit: number): Promise<Array<{ tenant_id: string; envelope_id: string }>> {
    return this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; envelope_id: string }>>(
      `SELECT e.tenant_id::text AS tenant_id, e.id::text AS envelope_id
         FROM "sign"."SignatureEnvelope" e
        WHERE e.status IN ('COMPLETED', 'DECLINED', 'VOIDED')
          AND e.purge_state IS NULL
          AND e.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM "sign"."SignEnvelopePartyDeletion" d
                       WHERE d.envelope_id = e.id AND d.party_kind = 'SENDER' AND d.party_key = e.tenant_id AND d.restored_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM "sign"."SignRecipientBinding" b
                           WHERE b.envelope_id = e.id AND b.revoked_at IS NULL
                             AND NOT EXISTS (SELECT 1 FROM "sign"."SignEnvelopePartyDeletion" d
                                              WHERE d.envelope_id = e.id AND d.party_kind = 'RECIPIENT' AND d.party_key = b.user_id AND d.restored_at IS NULL))
          AND ${NOT_HELD('e')}
        ORDER BY e.updated_at ASC
        LIMIT $1`,
      limit,
    );
  }

  /** Queued purges that are due, not waiting on an Object Lock, for tenants not held. */
  async dueForExecution(now: Date, limit: number): Promise<DueEnvelope[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; envelope_id: string; level: string; reason: string }>>(
      `SELECT e.tenant_id::text AS tenant_id, e.id::text AS envelope_id, e.purge_level AS level, e.purge_reason AS reason
         FROM "sign"."SignatureEnvelope" e
        WHERE e.purge_state = 'QUEUED'
          AND e.purge_due_at <= $1
          AND (e.purge_waiting_until IS NULL OR e.purge_waiting_until <= $1)
          AND ${NOT_HELD('e')}
        ORDER BY e.purge_due_at ASC
        LIMIT $2`,
      now,
      limit,
    );
    return rows.map((r) => ({ tenant_id: r.tenant_id, envelope_id: r.envelope_id, level: r.level as PurgeLevel, reason: r.reason as EsignPurgeReason }));
  }

  /** R-9: the tenant's terminal envelopes sent from, or signed by, an email address. */
  async targetedEnvelopeIds(tenant_id: string, email: string): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT DISTINCT e.id::text AS id
         FROM "sign"."SignatureEnvelope" e
        WHERE e.tenant_id = $1::uuid
          AND e.status IN ('COMPLETED', 'DECLINED', 'VOIDED')
          AND e.deleted_at IS NULL
          AND (EXISTS (SELECT 1 FROM "sign"."Signer" s WHERE s.envelope_id = e.id AND lower(s.email) = lower($2))
               OR EXISTS (SELECT 1 FROM identity."User" u WHERE u.id = e.created_by AND lower(u.email) = lower($2)))`,
      tenant_id,
      email,
    );
    return rows.map((r) => r.id);
  }

  /** R-11: every terminal envelope of a closing tenant. */
  async tenantTerminalEnvelopeIds(tenant_id: string): Promise<string[]> {
    const rows = await this.prisma.signatureEnvelope.findMany({
      where: { tenant_id, status: { in: [...PURGE_ELIGIBLE_STATUSES] }, deleted_at: null, NOT: { purge_state: 'EXECUTED' } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** The queued envelope must wait for an S3 Object Lock (R-16): retried after `until`. */
  async markWaiting(tenant_id: string, envelope_id: string, until: Date): Promise<void> {
    await this.prisma.signatureEnvelope.updateMany({ where: { id: envelope_id, tenant_id, purge_state: 'QUEUED' }, data: { purge_waiting_until: until } });
  }

  /**
   * R-13 — for an integration envelope (sent by an application, e.g. the ATS) that completed:
   * whether its executed event ever reached the integration (a DELIVERED subscription webhook
   * or a published outbox event). null when the envelope is not an integration envelope.
   */
  async integrationCopyDelivered(tenant_id: string, envelope_id: string): Promise<boolean | null> {
    const env = await this.prisma.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: { source_application: true, status: true } });
    if (env === null || env.source_application === 'aramo-sign' || env.status !== 'COMPLETED') return null;
    const delivered = await this.prisma.signWebhookDelivery.count({ where: { tenant_id, envelope_id, event_type: 'sign.envelope.executed.v1', status: 'DELIVERED' } });
    if (delivered > 0) return true;
    const published = await this.prisma.outboxEvent.count({ where: { tenant_id, event_type: 'sign.envelope.executed.v1', published_at: { not: null }, event_payload: { path: ['envelope_id'], equals: envelope_id } } });
    return published > 0;
  }

  /** True when the tenant is under Aramo's internal legal hold (R-12). */
  async tenantHeld(tenant_id: string): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ held: boolean }>>(`SELECT legal_hold AS held FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
    return rows[0]?.held === true;
  }

  // ── W4: execution (database part; S3 objects are removed first by the caller) ──

  async execute(tenant_id: string, envelope_id: string, objects: PurgeObjectsReport, now: Date = new Date()): Promise<ExecuteOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as never, tenant_id, envelope_id);
      const e = await this.envelopeRow(tx, tenant_id, envelope_id);
      if (e === null || e.purge_state !== 'QUEUED' || e.purge_due_at === null || e.purge_due_at > now) return { status: 'not_due' };
      if (e.purge_waiting_until !== null && e.purge_waiting_until > now) return { status: 'not_due' };
      const held = await tx.$queryRawUnsafe<Array<{ held: boolean }>>(`SELECT legal_hold AS held FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
      if (held[0]?.held === true) return { status: 'held' };
      const level = e.purge_level as PurgeLevel;

      // Documents (every level): bytes go, rows / hashes / custody records stay (LD-3, LD-4).
      const documents = await tx.executedDocument.updateMany({ where: { tenant_id, envelope_id, purged_at: null }, data: { executed_bytes: null, purged_at: now } });
      const certificates = await tx.executionCertificate.updateMany({ where: { tenant_id, envelope_id, purged_at: null }, data: { certificate_bytes: null, purged_at: now } });
      const docIds = (await tx.envelopeDocument.findMany({ where: { tenant_id, envelope_id }, select: { id: true } })).map((d) => d.id);
      if (docIds.length > 0) await tx.signEnvelopeDocumentPages.deleteMany({ where: { tenant_id, envelope_document_id: { in: docIds } } });

      let events_redacted = 0;
      if (LEVEL_RANK[level] >= LEVEL_RANK.DOCUMENTS_AND_METADATA) {
        await tx.signatureEnvelope.update({ where: { id: envelope_id }, data: { subject: PURGED_TEXT, message: null } });
        await tx.envelopeDocument.updateMany({ where: { tenant_id, envelope_id }, data: { title: PURGED_TEXT } });
        if (docIds.length > 0) await tx.signatureField.updateMany({ where: { tenant_id, envelope_document_id: { in: docIds } }, data: { value: null } });
      }
      if (LEVEL_RANK[level] >= LEVEL_RANK.DOCUMENTS_AND_METADATA_AND_REDACT) {
        const signerIds = (await tx.signer.findMany({ where: { tenant_id, envelope_id }, select: { id: true } })).map((s) => s.id);
        await tx.signer.updateMany({ where: { tenant_id, envelope_id }, data: { name: REDACTED_TEXT, email: REDACTED_TEXT, decline_reason: null } /* email stays non-null: Signer_email_required_check */ });
        if (signerIds.length > 0) {
          await tx.signerDisclosureAcceptance.updateMany({ where: { tenant_id, signer_id: { in: signerIds } }, data: { ip_address: null, user_agent: null, attested_name: null } });
        }
        await tx.signRecipientBinding.updateMany({ where: { envelope_id }, data: { email: REDACTED_TEXT } });
        await tx.notificationDelivery.updateMany({ where: { tenant_id, envelope_id }, data: { last_error: null } });
        events_redacted = await this.redactLedger(tx, tenant_id, envelope_id, now);
      }

      await this.repo.appendEvent(tx as never, {
        tenant_id,
        envelope_id,
        event_type: PURGED_EVENT,
        actor_type: 'SERVICE',
        payload: {
          level,
          purge_reason: e.purge_reason,
          executed_documents: documents.count,
          certificates: certificates.count,
          s3_versions_deleted: objects.deleted,
          s3_versions_locked: objects.locked.length,
          events_redacted,
        },
      });
      await tx.signatureEnvelope.update({ where: { id: envelope_id }, data: { purge_state: 'EXECUTED', purge_executed_at: now, purge_waiting_until: null } });
      await this.enqueuePurgeEvent(tx, tenant_id, envelope_id, 'executed', null, e.purge_reason as EsignPurgeReason);
      return { status: 'executed', level, documents: documents.count, certificates: certificates.count, events_redacted };
    });
  }

  // LD-2 — for each event carrying personal data: verify its hash from the unredacted row,
  // write the SignatureEventRedaction record (original hash, payload commitment, verdict),
  // then clear ip_address / user_agent and replace PII payload values with "[REDACTED]".
  // event_hash / previous_event_hash never change.
  private async redactLedger(tx: Tx, tenant_id: string, envelope_id: string, now: Date): Promise<number> {
    const events = await tx.signatureEvent.findMany({
      where: { tenant_id, envelope_id, redaction: null },
      orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
    });
    let count = 0;
    for (const ev of events) {
      const payload = ev.payload as unknown;
      const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
      const keys = isObject ? Object.keys(payload as Record<string, unknown>).filter((k) => PII_PAYLOAD_KEYS.includes(k) && (payload as Record<string, unknown>)[k] !== REDACTED_PAYLOAD_VALUE) : [];
      if (keys.length === 0 && ev.ip_address === null && ev.user_agent === null) continue;
      const recomputed = computeEventHash(ev.previous_event_hash, {
        envelope_id: ev.envelope_id,
        event_type: ev.event_type,
        actor_type: ev.actor_type,
        actor_ref: ev.actor_ref,
        payload: payload ?? null,
        occurred_at: ev.occurred_at.toISOString(),
      });
      await tx.signatureEventRedaction.create({
        data: {
          event_id: ev.id,
          tenant_id,
          envelope_id,
          redacted_at: now,
          redacted_fields: keys,
          original_event_hash: ev.event_hash,
          original_payload_sha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex'),
          verified_before_redaction: recomputed === ev.event_hash,
        },
      });
      const nextPayload = keys.length === 0 ? undefined : { ...(payload as Record<string, unknown>), ...Object.fromEntries(keys.map((k) => [k, REDACTED_PAYLOAD_VALUE])) };
      await tx.signatureEvent.update({
        where: { id: ev.id },
        data: { ip_address: null, user_agent: null, ...(nextPayload !== undefined ? { payload: nextPayload as never } : {}) },
      });
      count += 1;
    }
    return count;
  }

  // ── W5: per-party delete ("Deleted" folder) ───────────────────────────────

  async partyDelete(tenant_id: string, envelope_id: string, party: { kind: 'SENDER' | 'RECIPIENT'; key: string }, actor_user_id: string): Promise<'deleted' | 'already' | 'not_eligible'> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as never, tenant_id, envelope_id);
      const e = await this.envelopeRow(tx, tenant_id, envelope_id);
      if (e === null || !PURGE_ELIGIBLE_STATUSES.includes(e.status) && e.status !== 'EXPIRED') return 'not_eligible';
      const existing = await tx.signEnvelopePartyDeletion.findUnique({ where: { envelope_id_party_kind_party_key: { envelope_id, party_kind: party.kind, party_key: party.key } } });
      if (existing !== null && existing.restored_at === null) return 'already';
      if (existing === null) {
        await tx.signEnvelopePartyDeletion.create({ data: { id: randomUUID(), tenant_id, envelope_id, party_kind: party.kind, party_key: party.key, actor_user_id } });
      } else {
        await tx.signEnvelopePartyDeletion.update({ where: { id: existing.id }, data: { restored_at: null, deleted_at: new Date(), actor_user_id } });
      }
      await this.repo.appendEvent(tx as never, { tenant_id, envelope_id, event_type: PARTY_DELETED_EVENT, actor_type: 'SERVICE', actor_ref: actor_user_id, payload: { party_kind: party.kind } });
      return 'deleted';
    });
  }

  async partyRestore(tenant_id: string, envelope_id: string, party: { kind: 'SENDER' | 'RECIPIENT'; key: string }, actor_user_id: string): Promise<'restored' | 'not_deleted' | 'purged'> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelope(tx as never, tenant_id, envelope_id);
      const e = await this.envelopeRow(tx, tenant_id, envelope_id);
      if (e?.purge_state === 'EXECUTED') return 'purged';
      const existing = await tx.signEnvelopePartyDeletion.findUnique({ where: { envelope_id_party_kind_party_key: { envelope_id, party_kind: party.kind, party_key: party.key } } });
      if (existing === null || existing.restored_at !== null) return 'not_deleted';
      await tx.signEnvelopePartyDeletion.update({ where: { id: existing.id }, data: { restored_at: new Date() } });
      await this.repo.appendEvent(tx as never, { tenant_id, envelope_id, event_type: PARTY_RESTORED_EVENT, actor_type: 'SERVICE', actor_ref: actor_user_id, payload: { party_kind: party.kind } });
      return 'restored';
    });
  }

  /** Envelope ids this party has deleted (active rows): list filters hide or show them. */
  async deletedEnvelopeIds(party: { kind: 'SENDER' | 'RECIPIENT'; key: string }): Promise<string[]> {
    const rows = await this.prisma.signEnvelopePartyDeletion.findMany({ where: { party_kind: party.kind, party_key: party.key, restored_at: null }, select: { envelope_id: true } });
    return rows.map((r) => r.envelope_id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async envelopeRow(tx: Tx, tenant_id: string, envelope_id: string): Promise<EnvelopeRow | null> {
    const e = await tx.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: { id: true, tenant_id: true, status: true, deleted_at: true, ...PURGE_SELECT } });
    return e as unknown as EnvelopeRow | null;
  }

  private async recordTransition(
    tx: Tx,
    tenant_id: string,
    envelope_id: string,
    event_type: string,
    state: 'QUEUED' | 'DEQUEUED',
    level: PurgeLevel,
    reason: EsignPurgeReason,
    due: Date | null,
    actor_user_id: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.repo.appendEvent(tx as never, {
      tenant_id,
      envelope_id,
      event_type,
      actor_type: 'SERVICE',
      ...(actor_user_id !== null ? { actor_ref: actor_user_id } : {}),
      payload: { level, purge_reason: reason, due_at: due !== null ? due.toISOString() : null, ...extra },
    });
    await this.enqueuePurgeEvent(tx, tenant_id, envelope_id, purgeStateFor(state, level), due, reason);
  }

  private async enqueuePurgeEvent(tx: Tx, tenant_id: string, envelope_id: string, purge_state: EsignPurgeState, due: Date | null, reason: EsignPurgeReason): Promise<void> {
    await this.outbox.enqueue(tx, {
      event_type: SIGN_ENVELOPE_PURGE_EVENT_TYPE,
      envelope_id,
      tenant_id,
      correlation_id: randomUUID(),
      artifact_refs: { executed_document_ids: [], has_certificate: false },
      purge: { purge_state, purge_due_at: due !== null ? due.toISOString() : null, reason },
    });
  }
}

const PURGE_SELECT = {
  purge_state: true,
  purge_level: true,
  purge_reason: true,
  purge_queued_at: true,
  purge_due_at: true,
  purge_waiting_until: true,
  purge_executed_at: true,
} as const;

function toStatus(e: EnvelopeRow): EnvelopePurgeStatus | null {
  if (e.purge_state === null || e.purge_level === null || e.purge_queued_at === null || e.purge_due_at === null) return null;
  return {
    state: e.purge_state as EnvelopePurgeStatus['state'],
    level: e.purge_level as PurgeLevel,
    reason: e.purge_reason as EsignPurgeReason,
    queued_at: e.purge_queued_at,
    due_at: e.purge_due_at,
    waiting_until: e.purge_waiting_until,
    executed_at: e.purge_executed_at,
  };
}
