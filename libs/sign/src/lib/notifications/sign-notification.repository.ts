import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type SignNotificationAudience,
  type SignNotificationPreferences,
  type SignNotificationType,
} from './notification-kinds.js';

// Aramo Sign Mobile — persistence for the notification feed, push devices,
// preferences, the notification outbox and push jobs (M-A3 §1, §2, §9).
//
// OWNERSHIP: every feed / device / preference read and write is keyed by BOTH the
// owner's tenant_id and user_id (the verified auth context). Nothing here reads,
// changes or deletes another user's convenience data, except one thing: a provider
// token registered on a new device session revokes every OTHER registration of the
// same token (the physical device changed hands), so one account's pushes never
// reach a device another account now signs in on.

export interface NotificationOwner {
  tenant_id: string;
  user_id: string;
}

export interface FeedCursor {
  created_at: Date;
  id: string;
}

export interface FeedRow {
  id: string;
  type: string;
  audience: string;
  envelope_id: string;
  inbox_item_id: string | null;
  envelope_subject: string;
  actor_name: string | null;
  created_at: Date;
  read_at: Date | null;
}

export interface NotificationDraft {
  tenant_id: string;
  user_id: string;
  type: SignNotificationType;
  audience: SignNotificationAudience;
  envelope_id: string;
  inbox_item_id: string | null;
  envelope_subject: string;
  actor_name: string | null;
  dedupe_key: string;
  source_outbox_id: string;
}

export interface DeviceRegistration {
  owner: NotificationOwner;
  device_session_id: string;
  platform: 'ios' | 'android';
  provider: 'apns' | 'fcm';
  push_token_ciphertext: string;
  push_token_digest: string;
  app_version: string;
}

export interface ActiveDevice {
  id: string;
  provider: string;
  device_session_id: string;
}

export interface FanoutEnvelope {
  id: string;
  tenant_id: string;
  subject: string;
  status: string;
  created_by: string;
  routing_mode: string;
  source_application: string;
  origin_actor_kind: string;
  has_owned_document: boolean;
  signers: Array<{ id: string; name: string; email: string | null; status: string; signing_order: number; signed_at: Date | null; recipient_kind: string }>;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string | null;
  kind: string;
  actor_type: string;
  actor_ref: string | null;
  signer_ids: string[];
  attempt_count: number;
  created_at: Date;
}

export interface PushJobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  notification_id: string;
  payload_kind: string;
  attempts: number;
}

export interface PurgeCounts {
  devices_revoked: number;
  push_jobs_cancelled: number;
  devices_deleted: number;
  notifications_deleted: number;
  preferences_deleted: number;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class SignNotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Feed ──

  async listFeed(owner: NotificationOwner, opts: { cursor: FeedCursor | null; limit: number }): Promise<FeedRow[]> {
    const where: Record<string, unknown> = { tenant_id: owner.tenant_id, user_id: owner.user_id };
    if (opts.cursor !== null) {
      where['OR'] = [
        { created_at: { lt: opts.cursor.created_at } },
        { created_at: opts.cursor.created_at, id: { lt: opts.cursor.id } },
      ];
    }
    return this.prisma.signUserNotification.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      select: { id: true, type: true, audience: true, envelope_id: true, inbox_item_id: true, envelope_subject: true, actor_name: true, created_at: true, read_at: true },
    });
  }

  unreadCount(owner: NotificationOwner): Promise<number> {
    return this.prisma.signUserNotification.count({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, read_at: null } });
  }

  // True when the notification exists for this owner (read now or before).
  async markRead(owner: NotificationOwner, id: string): Promise<boolean> {
    const found = await this.prisma.signUserNotification.findFirst({ where: { id, tenant_id: owner.tenant_id, user_id: owner.user_id }, select: { read_at: true } });
    if (found === null) return false;
    if (found.read_at === null) {
      await this.prisma.signUserNotification.updateMany({ where: { id, tenant_id: owner.tenant_id, user_id: owner.user_id, read_at: null }, data: { read_at: new Date() } });
    }
    return true;
  }

  async markAllRead(owner: NotificationOwner): Promise<number> {
    const r = await this.prisma.signUserNotification.updateMany({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, read_at: null }, data: { read_at: new Date() } });
    return r.count;
  }

  // ── Preferences ──

  async getPreferences(owner: NotificationOwner): Promise<SignNotificationPreferences> {
    const row = await this.prisma.signNotificationPreference.findUnique({
      where: { tenant_id_user_id: { tenant_id: owner.tenant_id, user_id: owner.user_id } },
    });
    if (row === null) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return {
      signed: row.signed,
      viewed: row.viewed,
      declined: row.declined,
      signature_needed: row.signature_needed,
      reminders: row.reminders,
      lock_screen_subject: row.lock_screen_subject,
    };
  }

  async putPreferences(owner: NotificationOwner, prefs: SignNotificationPreferences): Promise<SignNotificationPreferences> {
    const now = new Date();
    await this.prisma.signNotificationPreference.upsert({
      where: { tenant_id_user_id: { tenant_id: owner.tenant_id, user_id: owner.user_id } },
      create: { id: randomUUID(), tenant_id: owner.tenant_id, user_id: owner.user_id, ...prefs },
      update: { ...prefs, updated_at: now },
    });
    return { ...prefs };
  }

  // ── Devices ──

  findDeviceBySession(device_session_id: string) {
    return this.prisma.signPushDevice.findUnique({ where: { device_session_id } });
  }

  findDevice(id: string) {
    return this.prisma.signPushDevice.findUnique({ where: { id } });
  }

  // Register or rotate the push token of the caller's own device session. Returns
  // 'not_owner' when the device session is registered to another owner (never
  // overwritten). Any OTHER live registration of the same token is revoked in the
  // same transaction, with its queued jobs cancelled.
  async upsertDevice(reg: DeviceRegistration): Promise<{ outcome: 'registered'; id: string } | { outcome: 'not_owner' }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.signPushDevice.findUnique({ where: { device_session_id: reg.device_session_id } });
      if (existing !== null && (existing.tenant_id !== reg.owner.tenant_id || existing.user_id !== reg.owner.user_id)) {
        return { outcome: 'not_owner' as const };
      }
      const others = await tx.signPushDevice.findMany({
        where: { push_token_digest: reg.push_token_digest, revoked_at: null, NOT: { device_session_id: reg.device_session_id } },
        select: { id: true },
      });
      for (const o of others) await this.revokeIn(tx, o.id, 'token_reregistered');
      const now = new Date();
      const data = {
        platform: reg.platform,
        provider: reg.provider,
        push_token_ciphertext: reg.push_token_ciphertext,
        push_token_digest: reg.push_token_digest,
        app_version: reg.app_version,
        last_seen_at: now,
        updated_at: now,
        revoked_at: null,
        revoke_reason: null,
      };
      const row = await tx.signPushDevice.upsert({
        where: { device_session_id: reg.device_session_id },
        create: { id: randomUUID(), tenant_id: reg.owner.tenant_id, user_id: reg.owner.user_id, device_session_id: reg.device_session_id, ...data },
        update: data,
        select: { id: true },
      });
      return { outcome: 'registered' as const, id: row.id };
    });
  }

  // Revoke the caller's registration on their own device session (idempotent).
  async revokeDeviceBySession(owner: NotificationOwner, device_session_id: string, reason: string): Promise<{ revoked: boolean; jobs_cancelled: number }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.signPushDevice.findFirst({
        where: { device_session_id, tenant_id: owner.tenant_id, user_id: owner.user_id, revoked_at: null },
        select: { id: true },
      });
      if (row === null) return { revoked: false, jobs_cancelled: 0 };
      const jobs = await this.revokeIn(tx, row.id, reason);
      return { revoked: true, jobs_cancelled: jobs };
    });
  }

  // M-A3 §9 — device revocation: mark revoked, delete the provider token material
  // and cancel every queued job, in one transaction. Returns the jobs cancelled.
  async revokeDevice(id: string, reason: string): Promise<number> {
    return this.prisma.$transaction((tx) => this.revokeIn(tx, id, reason));
  }

  private async revokeIn(tx: Tx, id: string, reason: string): Promise<number> {
    const now = new Date();
    await tx.signPushDevice.updateMany({
      where: { id, revoked_at: null },
      data: { revoked_at: now, revoke_reason: reason, push_token_ciphertext: null, push_token_digest: null, updated_at: now },
    });
    const cancelled = await tx.signPushJob.updateMany({
      where: { device_id: id, status: 'PENDING' },
      data: { status: 'CANCELLED', last_error_code: 'device_revoked', updated_at: now },
    });
    return cancelled.count;
  }

  listActiveDevices(owner: NotificationOwner, providers: readonly string[]): Promise<ActiveDevice[]> {
    if (providers.length === 0) return Promise.resolve([]);
    return this.prisma.signPushDevice.findMany({
      where: { tenant_id: owner.tenant_id, user_id: owner.user_id, revoked_at: null, provider: { in: [...providers] }, NOT: { push_token_ciphertext: null } },
      select: { id: true, provider: true, device_session_id: true },
    });
  }

  // ── Notification outbox (fan-out source) ──

  // Claim a due batch and LEASE it (next_attempt_at pushed out), so an overlapping
  // tick or another process does not take the same rows until the lease lapses.
  async claimOutbox(now: Date, limit: number, leaseMs: number): Promise<OutboxRow[]> {
    const due = await this.prisma.signNotificationOutbox.findMany({
      where: { processed_at: null, OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    if (due.length === 0) return [];
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimed: OutboxRow[] = [];
    for (const row of due) {
      // Compare-and-set on the lease: only the claimer that still sees the row due wins.
      const won = await this.prisma.signNotificationOutbox.updateMany({
        where: { id: row.id, processed_at: null, OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }] },
        data: { next_attempt_at: leaseUntil },
      });
      if (won.count === 1) claimed.push(row);
    }
    return claimed;
  }

  async markOutboxProcessed(id: string): Promise<void> {
    await this.prisma.signNotificationOutbox.update({ where: { id }, data: { processed_at: new Date(), last_error_code: null } });
  }

  async markOutboxFailed(id: string, attempts: number, error_code: string, next_attempt_at: Date | null): Promise<void> {
    await this.prisma.signNotificationOutbox.update({
      where: { id },
      data: next_attempt_at === null
        ? { attempt_count: attempts, last_error_code: error_code.slice(0, 64), processed_at: new Date() }
        : { attempt_count: attempts, last_error_code: error_code.slice(0, 64), next_attempt_at },
    });
  }

  async envelopeForFanout(tenant_id: string, envelope_id: string): Promise<FanoutEnvelope | null> {
    const env = await this.prisma.signatureEnvelope.findFirst({
      where: { id: envelope_id, tenant_id },
      select: {
        id: true,
        tenant_id: true,
        subject: true,
        status: true,
        created_by: true,
        routing_mode: true,
        source_application: true,
        origin_actor_kind: true,
        documents: { select: { source_mode: true } },
        signers: { select: { id: true, name: true, email: true, status: true, signing_order: true, signed_at: true, recipient_kind: true }, orderBy: { signing_order: 'asc' } },
      },
    });
    if (env === null) return null;
    const { documents, ...rest } = env;
    return { ...rest, has_owned_document: documents.some((d) => d.source_mode === 'OWNED') };
  }

  // The live inbox claims of these signers (recipient bindings, S-7).
  async activeBindings(envelope_id: string, signer_ids: readonly string[]): Promise<Array<{ id: string; signer_id: string; user_id: string; user_tenant_id: string }>> {
    if (signer_ids.length === 0) return [];
    return this.prisma.signRecipientBinding.findMany({
      where: { envelope_id, signer_id: { in: [...signer_ids] }, revoked_at: null },
      select: { id: true, signer_id: true, user_id: true, user_tenant_id: true },
    });
  }

  // Idempotent: the (user_id, dedupe_key) unique key keeps exactly one row per
  // source event and user. Returns the row (new or existing).
  async upsertNotification(d: NotificationDraft): Promise<{ id: string; source_outbox_id: string | null }> {
    await this.prisma.signUserNotification.createMany({ data: [{ id: randomUUID(), ...d }], skipDuplicates: true });
    return this.prisma.signUserNotification.findUniqueOrThrow({
      where: { user_id_dedupe_key: { user_id: d.user_id, dedupe_key: d.dedupe_key } },
      select: { id: true, source_outbox_id: true },
    });
  }

  async enqueuePushJobs(rows: Array<{ tenant_id: string; user_id: string; device_id: string; notification_id: string; payload_kind: string }>): Promise<number> {
    if (rows.length === 0) return 0;
    const r = await this.prisma.signPushJob.createMany({ data: rows.map((j) => ({ id: randomUUID(), ...j })), skipDuplicates: true });
    return r.count;
  }

  countPushJobsSince(owner: NotificationOwner, since: Date): Promise<number> {
    return this.prisma.signPushJob.count({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, created_at: { gte: since } } });
  }

  // ── Push jobs ──

  async claimPushJobs(now: Date, limit: number, leaseMs: number): Promise<PushJobRow[]> {
    const due = await this.prisma.signPushJob.findMany({
      where: { status: 'PENDING', next_attempt_at: { lte: now } },
      orderBy: [{ next_attempt_at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimed: PushJobRow[] = [];
    for (const job of due) {
      const won = await this.prisma.signPushJob.updateMany({
        where: { id: job.id, status: 'PENDING', next_attempt_at: { lte: now } },
        data: { next_attempt_at: leaseUntil },
      });
      if (won.count === 1) claimed.push(job);
    }
    return claimed;
  }

  getNotification(id: string) {
    return this.prisma.signUserNotification.findUnique({ where: { id } });
  }

  async finishPushJob(id: string, status: 'SENT' | 'CANCELLED' | 'FAILED' | 'DEAD', attempts: number, error_code: string | null): Promise<void> {
    const now = new Date();
    await this.prisma.signPushJob.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, attempts, last_error_code: error_code === null ? null : error_code.slice(0, 64), updated_at: now, ...(status === 'SENT' ? { sent_at: now } : {}) },
    });
  }

  async retryPushJob(id: string, attempts: number, error_code: string, next_attempt_at: Date): Promise<void> {
    await this.prisma.signPushJob.updateMany({
      where: { id, status: 'PENDING' },
      data: { attempts, last_error_code: error_code.slice(0, 64), next_attempt_at, updated_at: new Date() },
    });
  }

  // M-A3 §9 (correction 6) — run `send` while holding a SHARE lock on the device
  // row, after re-reading its state under that lock. A revocation (an UPDATE of the
  // row) waits for the send to finish, so once a revocation has committed no later
  // send can reach that device: the job is dropped instead. `send` receives the
  // device's live token material, or the callback is not run at all (null result).
  async withLiveDeviceForSend<T>(
    device_id: string,
    send: (device: { id: string; provider: string; device_session_id: string; push_token_ciphertext: string }) => Promise<T>,
    timeoutMs: number,
  ): Promise<{ ran: true; result: T } | { ran: false }> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; provider: string; device_session_id: string; push_token_ciphertext: string | null; revoked_at: Date | null }>>`
          SELECT id, provider, device_session_id, push_token_ciphertext, revoked_at
          FROM "sign"."SignPushDevice" WHERE id = ${device_id}::uuid FOR SHARE`;
        const d = rows[0];
        if (d === undefined || d.revoked_at !== null || d.push_token_ciphertext === null) return { ran: false as const };
        const result = await send({ id: d.id, provider: d.provider, device_session_id: d.device_session_id, push_token_ciphertext: d.push_token_ciphertext });
        return { ran: true as const, result };
      },
      { timeout: timeoutMs, maxWait: 5_000 },
    );
  }

  // ── Native device session state (read-only; owned by auth-service, M-A1 §3.8) ──

  // The auth_storage row behind a token's dsid, or null when there is none. Throws
  // when the table is absent (a database without the M-A1 migration).
  async nativeDeviceSession(device_session_id: string): Promise<{ user_id: string; tenant_id: string; revoked_at: Date | null } | null> {
    // Same liveness rule as auth-storage `NativeDeviceSessionService.isActive`: the
    // session is open AND its current refresh token exists, is unrevoked and unexpired.
    // A session ended by a user-wide refresh-token revocation (reuse cascade, browser
    // logout-all) therefore reads as revoked here too.
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; tenant_id: string; revoked_at: Date | null }>>`
      SELECT s.user_id::text AS user_id, s.tenant_id::text AS tenant_id,
             CASE WHEN s.revoked_at IS NOT NULL THEN s.revoked_at
                  WHEN r.id IS NULL OR r.revoked_at IS NOT NULL OR r.expires_at <= now() THEN COALESCE(r.revoked_at, now())
                  ELSE NULL END AS revoked_at
      FROM "auth_storage"."NativeDeviceSession" s
      LEFT JOIN "auth_storage"."RefreshToken" r ON r.id = s.current_refresh_token_id
      WHERE s.id = ${device_session_id}::uuid`;
    return rows[0] ?? null;
  }

  // ── Account close (M-A3 §9) ──

  // Revoke every device of the owner (token material deleted, jobs cancelled), then
  // delete the owner's devices, feed and preferences, and record the counts — one
  // transaction. Idempotent: a second run finds nothing and records zeros.
  async purgeOwner(owner: NotificationOwner, reason: string): Promise<PurgeCounts> {
    return this.prisma.$transaction(async (tx) => {
      const where = { tenant_id: owner.tenant_id, user_id: owner.user_id };
      const live = await tx.signPushDevice.findMany({ where: { ...where, revoked_at: null }, select: { id: true } });
      let cancelled = 0;
      for (const d of live) cancelled += await this.revokeIn(tx, d.id, reason);
      const devices = await tx.signPushDevice.deleteMany({ where });
      const notifications = await tx.signUserNotification.deleteMany({ where });
      const preferences = await tx.signNotificationPreference.deleteMany({ where });
      const counts: PurgeCounts = {
        devices_revoked: live.length,
        push_jobs_cancelled: cancelled,
        devices_deleted: devices.count,
        notifications_deleted: notifications.count,
        preferences_deleted: preferences.count,
      };
      await tx.signConvenienceDataPurge.create({ data: { id: randomUUID(), ...where, reason, ...counts } });
      return counts;
    });
  }
}
