import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SIGN_IDEMPOTENCY_TTL_MS } from '../sign-idempotency.repository.js';

// Privacy Notice 1.1 remediation — retention cleanup (E-1 to E-4).
// Governing: Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED §4, decisions 2 to 5.
//
// CONVENIENCE DATA IS NOT SIGNING EVIDENCE. Nothing here reads, changes or deletes an
// envelope, signer, field value, signing session, ledger event (SignatureEvent),
// executed document, execution certificate, disclosure acceptance or legal
// acceptance. The tables this file deletes from are exactly:
//   E-1  sign.SignSavedSignature, SignContact, SignUserNotification,
//        SignNotificationPreference, SignPushDevice, SignPushJob (one user, one tenant)
//   E-2  auth_storage.NativeDeviceSession (consumer 'sign' only), sign.SignPushDevice (revoked)
//   E-3  sign.SignIdempotencyKey (expired)
//   E-4  sign.SignNotificationOutbox (processed), sign.SignPushJob (finished)
//
// HOLDS: the documented hold is identity."Tenant".legal_hold (a deletion-suspend
// marker, TM-L12). A tenant under legal hold is skipped by E-1, E-2 and E-4 — its rows
// stay until the hold is released. E-3 rows are short-lived request-replay records,
// not covered by a hold (Privacy Notice 1.1 §9 D-3 carries no hold exception).
// No per-user or security hold exists in the codebase.
//
// AUDIT: counts only, never row contents or identifiers of deleted rows. E-1 writes a
// SignConvenienceDataPurge row per (tenant, user) purge; E-2 to E-4 write a
// SignRetentionSweep row per job and tenant, in the SAME statement as the delete, so
// a deletion never commits without its evidence.
//
// CONCURRENCY: time-based sweeps claim rows with FOR UPDATE SKIP LOCKED, so two
// runners delete disjoint rows. An E-1 purge takes a transaction-scoped advisory lock
// on (tenant, user) and re-checks its trigger and the hold under it, so a second
// runner finds nothing left and records nothing.

/** Why a user's convenience data is purged (E-1). Stored in SignConvenienceDataPurge.reason. */
export type ConvenienceRetentionReason = 'organization_closed' | 'user_removed' | 'user_deactivated' | 'verified_request';

export type RetentionSweepJob = 'native_sessions' | 'revoked_push_devices' | 'idempotency_keys' | 'notification_outbox' | 'push_jobs';

/** A (tenant, user) whose convenience data is due for deletion (E-1). */
export interface ConvenienceTarget {
  tenant_id: string;
  user_id: string;
  reason: ConvenienceRetentionReason;
  /** Set for an operator-recorded verified request (trigger c). */
  request_id: string | null;
}

export interface ConvenienceDeletionCounts {
  saved_signatures_deleted: number;
  contacts_deleted: number;
  notifications_deleted: number;
  preferences_deleted: number;
  devices_deleted: number;
  devices_revoked: number;
  push_jobs_cancelled: number;
}

export type ConvenienceDeletionOutcome =
  | { status: 'purged'; purge_id: string; counts: ConvenienceDeletionCounts }
  // The tenant is under legal hold: nothing deleted, a request stays open.
  | { status: 'held' }
  // Nothing left to do (another runner finished it, the trigger no longer applies, or the request is already complete).
  | { status: 'skipped' };

/** Per-tenant counts of one sweep batch. */
export type SweepCounts = Array<{ tenant_id: string; deleted: number }>;

// E-1 — a removal or closure is acted on only after this grace period, so a
// compensating re-enable (the membership-disable saga restores a membership when its
// Cognito leg fails) never loses data. With the hourly default sweep, deletion still
// happens about one day after the trigger: well inside the 30-day promise.
export const CONVENIENCE_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;
// E-2 — terminated native sessions and revoked push devices are kept 180 days.
export const TERMINATED_SESSION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
// E-4 — processed outbox rows and finished push jobs are kept 30 days (identifiers
// only, no message content; internal delivery records used for troubleshooting).
export const DELIVERY_QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const NATIVE_SIGN_CONSUMER = 'sign';
const NOT_HELD = (alias: string) => `NOT EXISTS (SELECT 1 FROM identity."Tenant" h WHERE h.id = ${alias}.tenant_id AND h.legal_hold = true)`;

// Every (tenant, user) that owns convenience data, with the trigger that applies, in
// priority order (a closed organization first). $1 = the grace cutoff.
const TRIGGERED_OWNERS_SQL = `
  WITH owners AS (
    SELECT tenant_id, user_id FROM "sign"."SignSavedSignature"
    UNION SELECT tenant_id, owner_user_id FROM "sign"."SignContact"
    UNION SELECT tenant_id, user_id FROM "sign"."SignUserNotification"
    UNION SELECT tenant_id, user_id FROM "sign"."SignNotificationPreference"
    UNION SELECT tenant_id, user_id FROM "sign"."SignPushDevice"
    UNION SELECT tenant_id, user_id FROM "sign"."SignPushJob"
  ), triggered AS (
    SELECT o.tenant_id, o.user_id, 'organization_closed' AS reason, 1 AS priority
      FROM owners o JOIN identity."Tenant" t ON t.id = o.tenant_id
     WHERE t.status = 'CLOSED' AND COALESCE(t.closed_at, t.status_changed_at) <= $1
    UNION ALL
    SELECT o.tenant_id, o.user_id, 'user_removed', 2
      FROM owners o JOIN identity."UserTenantMembership" m ON m.user_id = o.user_id AND m.tenant_id = o.tenant_id
     WHERE m.is_active = false AND COALESCE(m.deactivated_at, m.updated_at) <= $1
    UNION ALL
    SELECT o.tenant_id, o.user_id, 'user_deactivated', 3
      FROM owners o JOIN identity."User" u ON u.id = o.user_id AND u.tenant_id = o.tenant_id
     WHERE u.is_active = false AND COALESCE(u.deactivated_at, u.updated_at) <= $1
  )
  SELECT DISTINCT ON (tr.tenant_id, tr.user_id) tr.tenant_id::text AS tenant_id, tr.user_id::text AS user_id, tr.reason, tr.priority
    FROM triggered tr
   WHERE ${NOT_HELD('tr')}`;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class SignRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── E-1 — business convenience data ──

  /**
   * The (tenant, user) pairs due for an E-1 purge: open verified requests first, then
   * owners whose organization closed or who were removed / deactivated more than the
   * grace period ago. Held tenants are excluded. Bounded by `limit`.
   */
  async dueConvenienceTargets(now: Date, limit: number): Promise<ConvenienceTarget[]> {
    const requests = await this.prisma.$queryRawUnsafe<Array<{ id: string; tenant_id: string; user_id: string }>>(
      `SELECT r.id::text AS id, r.tenant_id::text AS tenant_id, r.user_id::text AS user_id
         FROM "sign"."SignConvenienceDeletionRequest" r
        WHERE r.completed_at IS NULL AND ${NOT_HELD('r')}
        ORDER BY r.recorded_at, r.id
        LIMIT $1`,
      limit,
    );
    const out: ConvenienceTarget[] = requests.map((r) => ({ tenant_id: r.tenant_id, user_id: r.user_id, reason: 'verified_request', request_id: r.id }));
    if (out.length >= limit) return out;
    const owners = await this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; user_id: string; reason: ConvenienceRetentionReason }>>(
      `SELECT tenant_id, user_id, reason FROM (${TRIGGERED_OWNERS_SQL} ORDER BY tr.tenant_id, tr.user_id, tr.priority) due ORDER BY tenant_id, user_id LIMIT $2`,
      new Date(now.getTime() - CONVENIENCE_PURGE_GRACE_MS),
      limit - out.length,
    );
    for (const o of owners) out.push({ ...o, request_id: null });
    return out;
  }

  /**
   * Delete one user's convenience data in one tenant, with a counts-only audit row, in
   * one transaction. Re-checks the hold and the trigger under a (tenant, user) lock.
   * Idempotent: a repeat finds nothing and records nothing (a request is completed once).
   */
  async purgeConvenienceData(target: ConvenienceTarget, now: Date): Promise<ConvenienceDeletionOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `sign-retention:e1:${target.tenant_id}:${target.user_id}`);
      if (await this.tenantHeld(tx, target.tenant_id)) return { status: 'held' as const };
      if (target.request_id !== null) {
        const open = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id::text AS id FROM "sign"."SignConvenienceDeletionRequest"
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND user_id = $3::uuid AND completed_at IS NULL FOR UPDATE`,
          target.request_id,
          target.tenant_id,
          target.user_id,
        );
        if (open.length === 0) return { status: 'skipped' as const };
      } else {
        const still = await tx.$queryRawUnsafe<Array<{ reason: string }>>(
          `SELECT x.reason FROM (${TRIGGERED_OWNERS_SQL}) x WHERE x.tenant_id = $2 AND x.user_id = $3`,
          new Date(now.getTime() - CONVENIENCE_PURGE_GRACE_MS),
          target.tenant_id,
          target.user_id,
        );
        if (still.length === 0) return { status: 'skipped' as const };
      }

      const owner = { tenant_id: target.tenant_id, user_id: target.user_id };
      const devices_revoked = await tx.signPushDevice.count({ where: { ...owner, revoked_at: null } });
      const push_jobs_cancelled = await tx.signPushJob.count({ where: { ...owner, status: 'PENDING' } });
      await tx.signPushJob.deleteMany({ where: owner });
      const devices = await tx.signPushDevice.deleteMany({ where: owner });
      const notifications = await tx.signUserNotification.deleteMany({ where: owner });
      const preferences = await tx.signNotificationPreference.deleteMany({ where: owner });
      const saved = await tx.signSavedSignature.deleteMany({ where: owner });
      const contacts = await tx.signContact.deleteMany({ where: { tenant_id: target.tenant_id, owner_user_id: target.user_id } });
      const counts: ConvenienceDeletionCounts = {
        saved_signatures_deleted: saved.count,
        contacts_deleted: contacts.count,
        notifications_deleted: notifications.count,
        preferences_deleted: preferences.count,
        devices_deleted: devices.count,
        devices_revoked,
        push_jobs_cancelled,
      };
      const purge_id = randomUUID();
      await tx.signConvenienceDataPurge.create({ data: { id: purge_id, ...owner, reason: target.reason, ...counts, created_at: now } });
      if (target.request_id !== null) {
        await tx.signConvenienceDeletionRequest.update({ where: { id: target.request_id }, data: { completed_at: now, purge_id } });
      }
      return { status: 'purged' as const, purge_id, counts };
    });
  }

  // ── E-2 — terminated native sessions and revoked push devices (180 days) ──

  /**
   * Delete Aramo Sign native device sessions terminated more than 180 days ago. A
   * session is terminated when it was revoked (sign-out, device revoke), or its current
   * refresh token was revoked (user-wide revocation, reuse cascade) or expired; the
   * termination time is the first of those that applies. Returns per-tenant counts;
   * 0 rows when the auth_storage table is absent (an isolated sign database).
   */
  async sweepNativeSessions(now: Date, limit: number): Promise<SweepCounts> {
    const present = await this.prisma.$queryRawUnsafe<Array<{ t: string | null }>>(`SELECT to_regclass('auth_storage."NativeDeviceSession"')::text AS t`);
    if (present[0]?.t === null || present[0]?.t === undefined) return [];
    return this.sweep(
      'native_sessions',
      `SELECT s.id FROM auth_storage."NativeDeviceSession" s
         LEFT JOIN auth_storage."RefreshToken" r ON r.id = s.current_refresh_token_id
        WHERE s.consumer_type = '${NATIVE_SIGN_CONSUMER}'
          AND COALESCE(s.revoked_at, r.revoked_at, CASE WHEN r.id IS NULL THEN s.last_seen_at ELSE r.expires_at END) < $1
          AND ${NOT_HELD('s')}
        ORDER BY s.id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      `auth_storage."NativeDeviceSession"`,
      new Date(now.getTime() - TERMINATED_SESSION_RETENTION_MS),
      limit,
    );
  }

  /** Delete push devices revoked more than 180 days ago (their token material was removed at revocation). */
  async sweepRevokedPushDevices(now: Date, limit: number): Promise<SweepCounts> {
    return this.sweep(
      'revoked_push_devices',
      `SELECT d.id FROM "sign"."SignPushDevice" d
        WHERE d.revoked_at IS NOT NULL AND d.revoked_at < $1 AND ${NOT_HELD('d')}
        ORDER BY d.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      `"sign"."SignPushDevice"`,
      new Date(now.getTime() - TERMINATED_SESSION_RETENTION_MS),
      limit,
    );
  }

  // ── E-3 — expired request-idempotency records ──

  /**
   * Delete idempotency keys whose 24-hour retry window has closed (created_at + TTL <=
   * now). A key whose window is still open is never touched; run at least hourly, this
   * deletes each record well within 24 hours after it expires.
   */
  async sweepIdempotencyKeys(now: Date, limit: number): Promise<SweepCounts> {
    return this.sweep(
      'idempotency_keys',
      `SELECT k.id FROM "sign"."SignIdempotencyKey" k
        WHERE k.created_at <= $1
        ORDER BY k.created_at, k.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      `"sign"."SignIdempotencyKey"`,
      new Date(now.getTime() - SIGN_IDEMPOTENCY_TTL_MS),
      limit,
    );
  }

  // ── E-4 — processed notification outbox rows and finished push jobs (30 days) ──
  //
  // Retention classification: internal delivery queues. They hold identifiers only
  // (envelope, signer, actor, user, device and notification ids, a kind/status and an
  // error code), never message content or a capability token. They are NOT signing
  // evidence (the ledger event they were derived from is kept) and NOT the user's feed
  // (SignUserNotification is E-1 convenience data). Kept 30 days after they finish, for
  // delivery troubleshooting. Unprocessed outbox rows and PENDING jobs are never deleted.

  async sweepNotificationOutbox(now: Date, limit: number): Promise<SweepCounts> {
    return this.sweep(
      'notification_outbox',
      `SELECT o.id FROM "sign"."SignNotificationOutbox" o
        WHERE o.processed_at IS NOT NULL AND o.processed_at < $1 AND ${NOT_HELD('o')}
        ORDER BY o.processed_at, o.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      `"sign"."SignNotificationOutbox"`,
      new Date(now.getTime() - DELIVERY_QUEUE_RETENTION_MS),
      limit,
    );
  }

  async sweepFinishedPushJobs(now: Date, limit: number): Promise<SweepCounts> {
    return this.sweep(
      'push_jobs',
      `SELECT j.id FROM "sign"."SignPushJob" j
        WHERE j.status IN ('SENT', 'CANCELLED', 'FAILED', 'DEAD') AND j.updated_at < $1 AND ${NOT_HELD('j')}
        ORDER BY j.updated_at, j.id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      `"sign"."SignPushJob"`,
      new Date(now.getTime() - DELIVERY_QUEUE_RETENTION_MS),
      limit,
    );
  }

  // One batch: claim (SKIP LOCKED), delete, and record per-tenant counts — one statement.
  private async sweep(job: RetentionSweepJob, claimSql: string, table: string, cutoff: Date, limit: number): Promise<SweepCounts> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ tenant_id: string; deleted: number }>>(
      `WITH doomed AS (${claimSql}),
            gone AS (DELETE FROM ${table} x USING doomed d WHERE x.id = d.id RETURNING x.tenant_id)
       INSERT INTO "sign"."SignRetentionSweep" (id, job, tenant_id, deleted)
       SELECT gen_random_uuid(), '${job}', tenant_id, count(*)::int FROM gone GROUP BY tenant_id
       RETURNING tenant_id::text AS tenant_id, deleted`,
      cutoff,
      limit,
    );
    return rows;
  }

  private async tenantHeld(tx: Tx, tenant_id: string): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe<Array<{ held: boolean }>>(`SELECT legal_hold AS held FROM identity."Tenant" WHERE id = $1::uuid`, tenant_id);
    return rows[0]?.held === true;
  }
}
