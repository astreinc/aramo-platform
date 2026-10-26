import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PrismaService, SignRetentionRepository } from '@aramo/sign';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SignRetentionService } from '../app/retention/sign-retention.service.js';
import { SignRetentionWorker } from '../app/retention/sign-retention.worker.js';

// Privacy Notice 1.1 remediation — retention cleanup E-1 to E-4 against real Postgres
// (Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED §4/§5: "verify the
// retention jobs against real database fixtures, tenant isolation, holds, retries,
// concurrency and deletion audit evidence"). The full sign, identity and auth_storage
// migration chains are applied, so the new migration is exercised as shipped.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const IMAGE = 'data:image/png;base64,c2F2ZWQtc2lnbmF0dXJl';

// Tables that hold signing evidence or audit. E-1 must leave every one byte-identical
// (except the purge audit, which only gains rows).
const EVIDENCE_TABLES = [
  'SignatureEnvelope',
  'EnvelopeDocument',
  'Signer',
  'SignatureField',
  'SignatureEvent',
  'SigningSession',
  'SignerDisclosureAcceptance',
  'ExecutedDocument',
  'ExecutionCertificate',
  'ExecutedAccessGrant',
  'SignRecipientBinding',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign retention cleanup — E-1 to E-4 (Privacy Notice 1.1)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let repo: SignRetentionRepository;
  let svc: SignRetentionService;
  let svcB: SignRetentionService;
  const savedEnv: Record<string, string | undefined> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: number }>(sql, params))[0]?.n ?? 0);

  async function tenant(opts: { status?: string; closed_at?: Date | null; legal_hold?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at, closed_at, legal_hold) VALUES ($1,$2,$3,'BUSINESS',$4,true, now(), $5, $6)`,
      [id, `T ${id.slice(0, 8)}`, `t-${id.slice(0, 8)}`, opts.status ?? 'ACTIVE', opts.closed_at ?? null, opts.legal_hold ?? false],
    );
    return id;
  }

  async function user(tenant_id: string, opts: { removed_at?: Date; deactivated_at?: Date } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, is_active, deactivated_at, updated_at) VALUES ($1,$2,$2,$3,$4,$5, now())`, [
      id,
      `${id}@example.test`,
      tenant_id,
      opts.deactivated_at === undefined,
      opts.deactivated_at ?? null,
    ]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, deactivated_at, updated_at) VALUES ($1,$2,$3,$4,$5, now())`, [
      randomUUID(),
      id,
      tenant_id,
      opts.removed_at === undefined,
      opts.removed_at ?? null,
    ]);
    return id;
  }

  // One of each convenience row for (tenant, user): saved signature + initials, a
  // contact, a feed row, preferences, a live push device and a PENDING push job.
  async function convenience(tenant_id: string, user_id: string): Promise<void> {
    for (const slot of ['signature', 'initials']) {
      await db.query(
        `INSERT INTO "sign"."SignSavedSignature" (id, tenant_id, user_id, slot, kind, typed_name, image_data_url) VALUES ($1,$2,$3,$4,'TYPED','Pat Example',$5)`,
        [randomUUID(), tenant_id, user_id, slot, IMAGE],
      );
    }
    await db.query(`INSERT INTO "sign"."SignContact" (id, tenant_id, owner_user_id, name, email, email_key) VALUES ($1,$2,$3,'Ann','ann@example.test','ann@example.test')`, [
      randomUUID(),
      tenant_id,
      user_id,
    ]);
    const notification = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key) VALUES ($1,$2,$3,'SIGNED','SENDER',$4,'Offer',$5)`,
      [notification, tenant_id, user_id, randomUUID(), `d-${notification}`],
    );
    await db.query(`INSERT INTO "sign"."SignNotificationPreference" (id, tenant_id, user_id) VALUES ($1,$2,$3)`, [randomUUID(), tenant_id, user_id]);
    const device = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, push_token_ciphertext, push_token_digest, app_version) VALUES ($1,$2,$3,$4,'ios','apns','cipher','digest','1.0.0')`,
      [device, tenant_id, user_id, randomUUID()],
    );
    await db.query(`INSERT INTO "sign"."SignPushJob" (id, tenant_id, user_id, device_id, notification_id, payload_kind) VALUES ($1,$2,$3,$4,$5,'SIGNED')`, [
      randomUUID(),
      tenant_id,
      user_id,
      device,
      notification,
    ]);
  }

  async function convenienceCount(tenant_id: string, user_id: string): Promise<number> {
    return n(
      `SELECT (SELECT count(*) FROM "sign"."SignSavedSignature" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignContact" WHERE tenant_id=$1 AND owner_user_id=$2)
            + (SELECT count(*) FROM "sign"."SignUserNotification" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignNotificationPreference" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignPushDevice" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignPushJob" WHERE tenant_id=$1 AND user_id=$2) AS n`,
      [tenant_id, user_id],
    );
  }
  const SEEDED = 7; // 2 saved + 1 contact + 1 feed + 1 preference + 1 device + 1 job

  const purgeRows = (tenant_id: string, user_id: string) =>
    q<Record<string, unknown>>(
      `SELECT reason, saved_signatures_deleted, contacts_deleted, notifications_deleted, preferences_deleted, devices_deleted, devices_revoked, push_jobs_cancelled
         FROM "sign"."SignConvenienceDataPurge" WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at`,
      [tenant_id, user_id],
    );
  const FULL_COUNTS = {
    saved_signatures_deleted: 2,
    contacts_deleted: 1,
    notifications_deleted: 1,
    preferences_deleted: 1,
    devices_deleted: 1,
    devices_revoked: 1,
    push_jobs_cancelled: 1,
  };

  const run = (s: SignRetentionService = svc, queues = true) => s.run({ queues }, NOW);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription', 'auth-storage']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    prismaA = new PrismaService(url);
    prismaB = new PrismaService(url);
    await prismaA.$connect();
    await prismaB.$connect();
    repo = new SignRetentionRepository(prismaA);
    svc = new SignRetentionService(repo);
    svcB = new SignRetentionService(new SignRetentionRepository(prismaB));
    for (const k of ['SIGN_RETENTION_WORKER_ENABLED', 'SIGN_RETENTION_QUEUE_CLEANUP_ENABLED', 'SIGN_RETENTION_INTERVAL_MS']) savedEnv[k] = process.env[k];
  }, 300_000);

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  // ── default off ──

  it('the worker is OFF by default: nothing is scheduled and no row is deleted until SIGN_RETENTION_WORKER_ENABLED=1', async () => {
    const t = await tenant({ status: 'CLOSED', closed_at: ago(3 * DAY) });
    const u = await user(t);
    await convenience(t, u);
    for (const value of [undefined, '0', 'true', 'yes']) {
      if (value === undefined) delete process.env['SIGN_RETENTION_WORKER_ENABLED'];
      else process.env['SIGN_RETENTION_WORKER_ENABLED'] = value;
      const worker = new SignRetentionWorker(svc);
      worker.onApplicationBootstrap();
      expect(worker.scheduled).toBe(false);
      await worker.onApplicationShutdown();
    }
    expect(await convenienceCount(t, u)).toBe(SEEDED);

    process.env['SIGN_RETENTION_WORKER_ENABLED'] = '1';
    const on = new SignRetentionWorker(svc);
    on.onApplicationBootstrap();
    expect(on.scheduled).toBe(true);
    await on.onApplicationShutdown();
    expect(on.scheduled).toBe(false);
  });

  it('E-4 is OFF unless SIGN_RETENTION_QUEUE_CLEANUP_ENABLED=1: a run without it keeps processed outbox rows and finished jobs', async () => {
    const t = await tenant();
    const outbox = randomUUID();
    await db.query(`INSERT INTO "sign"."SignNotificationOutbox" (id, tenant_id, envelope_id, kind, actor_type, processed_at) VALUES ($1,$2,$3,'SIGNED','SIGNER',$4)`, [
      outbox,
      t,
      randomUUID(),
      ago(40 * DAY),
    ]);
    delete process.env['SIGN_RETENTION_QUEUE_CLEANUP_ENABLED'];
    const worker = new SignRetentionWorker(svc);
    await worker.tick();
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignNotificationOutbox" WHERE id=$1`, [outbox])).toBe(1);
    const report = await run(svc, false);
    expect(report.notification_outbox).toBeNull();
    expect(report.push_jobs).toBeNull();
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignNotificationOutbox" WHERE id=$1`, [outbox])).toBe(1);
    await db.query(`DELETE FROM "sign"."SignNotificationOutbox" WHERE id=$1`, [outbox]);
  });

  // ── E-1 ──

  it('E-1 removal: a user removed from the organization more than a day ago loses their convenience data; colleagues, recent removals and other tenants are untouched', async () => {
    const t = await tenant();
    const other = await tenant();
    const removed = await user(t, { removed_at: ago(2 * DAY) });
    const deactivated = await user(t, { deactivated_at: ago(3 * DAY) });
    const colleague = await user(t);
    const justRemoved = await user(t, { removed_at: ago(HOUR) });
    for (const u of [removed, deactivated, colleague, justRemoved]) await convenience(t, u);
    // The removed user's rows in ANOTHER tenant (where they were never removed) stay.
    await convenience(other, removed);

    const report = await run();
    expect(report.convenience.failed).toBe(0);

    expect(await convenienceCount(t, removed)).toBe(0);
    expect(await convenienceCount(t, deactivated)).toBe(0);
    expect(await convenienceCount(t, colleague)).toBe(SEEDED);
    expect(await convenienceCount(t, justRemoved)).toBe(SEEDED);
    expect(await convenienceCount(other, removed)).toBe(SEEDED);
    expect(await purgeRows(t, removed)).toEqual([{ reason: 'user_removed', ...FULL_COUNTS }]);
    expect(await purgeRows(t, deactivated)).toEqual([{ reason: 'user_deactivated', ...FULL_COUNTS }]);
    expect(await purgeRows(t, colleague)).toEqual([]);
    expect(await purgeRows(other, removed)).toEqual([]);
  });

  it('E-1 organization closure: every user of a tenant closed more than a day ago is purged; a tenant closed an hour ago is not yet', async () => {
    const closed = await tenant({ status: 'CLOSED', closed_at: ago(5 * DAY) });
    const fresh = await tenant({ status: 'CLOSED', closed_at: ago(HOUR) });
    const a = await user(closed);
    const b = await user(closed);
    const c = await user(fresh);
    for (const [t, u] of [[closed, a], [closed, b], [fresh, c]] as const) await convenience(t, u);

    await run();
    expect(await convenienceCount(closed, a)).toBe(0);
    expect(await convenienceCount(closed, b)).toBe(0);
    expect(await convenienceCount(fresh, c)).toBe(SEEDED);
    expect(await purgeRows(closed, a)).toEqual([{ reason: 'organization_closed', ...FULL_COUNTS }]);
  });

  it('E-1 verified request: an operator-recorded request purges one active user only and is completed with the purge id; a request with no data completes with zero counts', async () => {
    const t = await tenant();
    const subject = await user(t);
    const colleague = await user(t);
    const empty = await user(t);
    await convenience(t, subject);
    await convenience(t, colleague);
    const req = randomUUID();
    const reqEmpty = randomUUID();
    for (const [id, u] of [[req, subject], [reqEmpty, empty]] as const) {
      await db.query(`INSERT INTO "sign"."SignConvenienceDeletionRequest" (id, tenant_id, user_id, verified_by, verification_ref) VALUES ($1,$2,$3,'ops@aramo.ai','CASE-1')`, [id, t, u]);
    }

    await run();
    expect(await convenienceCount(t, subject)).toBe(0);
    expect(await convenienceCount(t, colleague)).toBe(SEEDED);
    const [done] = await q<{ completed_at: Date | null; purge_id: string | null }>(`SELECT completed_at, purge_id FROM "sign"."SignConvenienceDeletionRequest" WHERE id=$1`, [req]);
    expect(done?.completed_at).not.toBeNull();
    const [purge] = await q<{ id: string; reason: string }>(`SELECT id, reason FROM "sign"."SignConvenienceDataPurge" WHERE tenant_id=$1 AND user_id=$2`, [t, subject]);
    expect(done?.purge_id).toBe(purge?.id);
    expect(purge?.reason).toBe('verified_request');
    expect(await purgeRows(t, empty)).toEqual([
      { reason: 'verified_request', saved_signatures_deleted: 0, contacts_deleted: 0, notifications_deleted: 0, preferences_deleted: 0, devices_deleted: 0, devices_revoked: 0, push_jobs_cancelled: 0 },
    ]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDeletionRequest" WHERE id = ANY($1::uuid[]) AND completed_at IS NULL`, [[req, reqEmpty]])).toBe(0);
  });

  it('E-1 legal hold: a tenant under legal hold keeps everything (closure, removal and request alike) until the hold is released', async () => {
    const held = await tenant({ status: 'CLOSED', closed_at: ago(10 * DAY), legal_hold: true });
    const removed = await user(held, { removed_at: ago(10 * DAY) });
    const requested = await user(held);
    await convenience(held, removed);
    await convenience(held, requested);
    const req = randomUUID();
    await db.query(`INSERT INTO "sign"."SignConvenienceDeletionRequest" (id, tenant_id, user_id, verified_by, verification_ref) VALUES ($1,$2,$3,'ops@aramo.ai','CASE-2')`, [req, held, requested]);

    await run();
    expect(await convenienceCount(held, removed)).toBe(SEEDED);
    expect(await convenienceCount(held, requested)).toBe(SEEDED);
    expect(await purgeRows(held, removed)).toEqual([]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDeletionRequest" WHERE id=$1 AND completed_at IS NULL`, [req])).toBe(1);
    // A target computed before the hold was placed is refused under the lock too.
    expect(await repo.purgeConvenienceData({ tenant_id: held, user_id: removed, reason: 'user_removed', request_id: null }, NOW)).toEqual({ status: 'held' });

    await db.query(`UPDATE identity."Tenant" SET legal_hold = false WHERE id=$1`, [held]);
    await run();
    expect(await convenienceCount(held, removed)).toBe(0);
    expect(await convenienceCount(held, requested)).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDeletionRequest" WHERE id=$1 AND completed_at IS NOT NULL`, [req])).toBe(1);
  });

  it('E-1 retries are idempotent: a second run deletes nothing and records nothing; a re-enabled user is no longer purged', async () => {
    const t = await tenant();
    const u = await user(t, { removed_at: ago(2 * DAY) });
    await convenience(t, u);
    await run();
    expect(await purgeRows(t, u)).toHaveLength(1);
    const before = await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDataPurge"`);
    await run();
    await run();
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDataPurge"`)).toBe(before);
    expect(await purgeRows(t, u)).toHaveLength(1);

    // Re-enabled (the disable saga's compensation, or an admin): new data is kept.
    await db.query(`UPDATE identity."UserTenantMembership" SET is_active = true, deactivated_at = NULL WHERE user_id=$1`, [u]);
    await convenience(t, u);
    await run();
    expect(await convenienceCount(t, u)).toBe(SEEDED);
    // A stale target (trigger no longer applies) is skipped under the lock.
    expect(await repo.purgeConvenienceData({ tenant_id: t, user_id: u, reason: 'user_removed', request_id: null }, NOW)).toEqual({ status: 'skipped' });
    expect(await convenienceCount(t, u)).toBe(SEEDED);
  });

  it('E-1 concurrency: two runners at once purge each user exactly once', async () => {
    const t = await tenant({ status: 'CLOSED', closed_at: ago(3 * DAY) });
    const users: string[] = [];
    for (let i = 0; i < 12; i++) users.push(await user(t));
    for (const u of users) await convenience(t, u);
    const req = randomUUID();
    await db.query(`INSERT INTO "sign"."SignConvenienceDeletionRequest" (id, tenant_id, user_id, verified_by, verification_ref) VALUES ($1,$2,$3,'ops@aramo.ai','CASE-3')`, [req, t, users[0]]);

    const [ra, rb] = await Promise.all([run(svc), run(svcB)]);
    expect(ra.convenience.failed + rb.convenience.failed).toBe(0);
    for (const u of users) expect(await convenienceCount(t, u)).toBe(0);
    // Exactly one purge with the full counts per user (the request's user may have a
    // second, zero-count row when the request is processed after the closure purge).
    const rows = await q<{ user_id: string; total: number; full: number }>(
      `SELECT user_id::text AS user_id,
              sum(saved_signatures_deleted + contacts_deleted + notifications_deleted + preferences_deleted + devices_deleted)::int AS total,
              (count(*) FILTER (WHERE saved_signatures_deleted > 0))::int AS full
         FROM "sign"."SignConvenienceDataPurge" WHERE tenant_id=$1 GROUP BY user_id`,
      [t],
    );
    expect(rows).toHaveLength(12);
    for (const r of rows) expect([r.total, r.full]).toEqual([6, 1]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignConvenienceDeletionRequest" WHERE id=$1 AND completed_at IS NOT NULL`, [req])).toBe(1);
  });

  it('E-1 never touches signing evidence: a signed envelope keeps its signature value, ledger and executed records after the signer’s saved signature is purged', async () => {
    const t = await tenant();
    const sender = await user(t, { removed_at: ago(2 * DAY) });
    await convenience(t, sender);
    const envelope = randomUUID();
    const signer = randomUUID();
    const doc = randomUUID();
    const field = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Offer','COMPLETED','MULTI_SIGNATURE',$3, now(), now() + interval '30 days')`,
      [envelope, t, sender],
    );
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,$4,'Pat Example',1,'SIGNED')`, [
      signer,
      t,
      envelope,
      `${sender}@example.test`,
    ]);
    await db.query(`INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal) VALUES ($1,$2,$3,$4,$5,'Offer',$6,1)`, [
      doc,
      t,
      envelope,
      randomUUID(),
      randomUUID(),
      'a'.repeat(64),
    ]);
    // The executed value is the same image as the saved signature (it was filled from it).
    await db.query(
      `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, signer_id, field_type, signature_method, page_number, x, y, value, filled_at) VALUES ($1,$2,$3,$4,'SIGNATURE','TYPED',1,10,10,$5, now())`,
      [field, t, doc, signer, IMAGE],
    );
    await db.query(`INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash) VALUES ($1,$2,$3,'ENVELOPE_CREATED','SYSTEM',NULL,'h1')`, [
      randomUUID(),
      t,
      envelope,
    ]);
    await db.query(`INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, signer_id, event_type, actor_type, previous_event_hash, event_hash) VALUES ($1,$2,$3,$4,'FIELD_FILLED','SIGNER','h1','h2')`, [
      randomUUID(),
      t,
      envelope,
      signer,
    ]);
    const snapshot = async () => {
      const out: Record<string, string | null> = {};
      for (const table of EVIDENCE_TABLES) {
        out[table] = (await q<{ h: string | null }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "sign"."${table}" x`))[0]?.h ?? null;
      }
      return out;
    };
    const before = await snapshot();

    await run();
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignSavedSignature" WHERE tenant_id=$1 AND user_id=$2`, [t, sender])).toBe(0);
    const [f] = await q<{ value: string; filled_at: Date | null }>(`SELECT value, filled_at FROM "sign"."SignatureField" WHERE id=$1`, [field]);
    expect(f?.value).toBe(IMAGE);
    expect(f?.filled_at).not.toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id=$1`, [envelope])).toBe(2);
  });

  // ── E-2 ──

  it('E-2: Sign native sessions and revoked push devices terminated more than 180 days ago are deleted; recent, live, other-consumer and held ones stay; counts are audited per tenant', async () => {
    const t = await tenant();
    const held = await tenant({ legal_hold: true });
    const u = await user(t);
    const hu = await user(held);
    const session = async (opts: { tenant_id: string; user_id: string; revoked_at?: Date | null; rt_revoked_at?: Date | null; rt_expires_at?: Date; consumer?: string }): Promise<string> => {
      const rt = randomUUID();
      const id = randomUUID();
      await db.query(
        `INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at, revoked_at) VALUES ($1,$2,$3,'sign_native',$4, now(), $5, $6)`,
        [rt, opts.user_id, opts.tenant_id, `h-${rt}`, opts.rt_expires_at ?? new Date(NOW.getTime() + 30 * DAY), opts.rt_revoked_at ?? null],
      );
      await db.query(
        `INSERT INTO auth_storage."NativeDeviceSession" (id, user_id, tenant_id, consumer_type, client_id, installation_id, platform, app_version, refresh_family_root_id, current_refresh_token_id, revoked_at, last_seen_at)
         VALUES ($1,$2,$3,$4,'aramo-sign-native','inst','ios','1.0.0',$5,$5,$6,$7)`,
        [id, opts.user_id, opts.tenant_id, opts.consumer ?? 'sign', rt, opts.revoked_at ?? null, ago(400 * DAY)],
      );
      return id;
    };
    const signedOutOld = await session({ tenant_id: t, user_id: u, revoked_at: ago(181 * DAY) });
    const userWideRevokedOld = await session({ tenant_id: t, user_id: u, rt_revoked_at: ago(200 * DAY) });
    const expiredOld = await session({ tenant_id: t, user_id: u, rt_expires_at: ago(200 * DAY) });
    const signedOutRecent = await session({ tenant_id: t, user_id: u, revoked_at: ago(179 * DAY) });
    const live = await session({ tenant_id: t, user_id: u });
    const otherConsumer = await session({ tenant_id: t, user_id: u, revoked_at: ago(300 * DAY), consumer: 'other' });
    const heldOld = await session({ tenant_id: held, user_id: hu, revoked_at: ago(300 * DAY) });

    const device = async (tenant_id: string, user_id: string, revoked_at: Date | null): Promise<string> => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, push_token_ciphertext, push_token_digest, app_version, revoked_at, revoke_reason) VALUES ($1,$2,$3,$4,'android','fcm',$5,$6,'1.0.0',$7,$8)`,
        [id, tenant_id, user_id, randomUUID(), revoked_at === null ? 'c' : null, revoked_at === null ? 'd' : null, revoked_at, revoked_at === null ? null : 'signed_out'],
      );
      return id;
    };
    const devOld = await device(t, u, ago(181 * DAY));
    const devRecent = await device(t, u, ago(10 * DAY));
    const devLive = await device(t, u, null);
    const devHeld = await device(held, hu, ago(300 * DAY));
    // A finished job on the old device goes with it (FK cascade).
    const notif = randomUUID();
    await db.query(`INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key) VALUES ($1,$2,$3,'SIGNED','SENDER',$4,'x',$5)`, [
      notif,
      t,
      u,
      randomUUID(),
      `d-${notif}`,
    ]);
    await db.query(`INSERT INTO "sign"."SignPushJob" (id, tenant_id, user_id, device_id, notification_id, payload_kind, status) VALUES ($1,$2,$3,$4,$5,'SIGNED','CANCELLED')`, [randomUUID(), t, u, devOld, notif]);

    const report = await run(svc, false);
    expect(report.native_sessions).toBe(3);
    expect(report.revoked_push_devices).toBe(1);
    const sessions = (await q<{ id: string }>(`SELECT id::text AS id FROM auth_storage."NativeDeviceSession"`)).map((r) => r.id);
    for (const gone of [signedOutOld, userWideRevokedOld, expiredOld]) expect(sessions).not.toContain(gone);
    for (const kept of [signedOutRecent, live, otherConsumer, heldOld]) expect(sessions).toContain(kept);
    const devices = (await q<{ id: string }>(`SELECT id::text AS id FROM "sign"."SignPushDevice"`)).map((r) => r.id);
    expect(devices).not.toContain(devOld);
    for (const kept of [devRecent, devLive, devHeld]) expect(devices).toContain(kept);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignPushJob" WHERE device_id=$1`, [devOld])).toBe(0);

    const audit = await q<{ job: string; deleted: number }>(`SELECT job, deleted FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1 ORDER BY job`, [t]);
    expect(audit).toEqual([
      { job: 'native_sessions', deleted: 3 },
      { job: 'revoked_push_devices', deleted: 1 },
    ]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1`, [held])).toBe(0);

    // Idempotent: a second run deletes and records nothing more for this tenant.
    await run(svc, false);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1`, [t])).toBe(2);
  });

  // ── E-3 ──

  it('E-3: idempotency keys are deleted once their 24-hour window has closed; an open window (completed or in progress) is never touched', async () => {
    const t = await tenant();
    const actor = randomUUID();
    const key = async (created_at: Date, status: number | null): Promise<string> => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "sign"."SignIdempotencyKey" (id, tenant_id, actor_id, operation, key, request_hash, response_status, created_at) VALUES ($1,$2,$3,'remind',$4,'h',$5,$6)`,
        [id, t, actor, `k-${id}`, status, created_at],
      );
      return id;
    };
    const expired = await key(ago(25 * HOUR), 202);
    const expiredInProgress = await key(ago(30 * HOUR), null);
    const open = await key(ago(23 * HOUR), 202);
    const openInProgress = await key(ago(HOUR), null);

    const report = await run(svc, false);
    expect(report.idempotency_keys).toBeGreaterThanOrEqual(2);
    const left = (await q<{ id: string }>(`SELECT id::text AS id FROM "sign"."SignIdempotencyKey" WHERE tenant_id=$1`, [t])).map((r) => r.id);
    expect(left.sort()).toEqual([open, openInProgress].sort());
    expect(left).not.toContain(expired);
    expect(left).not.toContain(expiredInProgress);
    expect(await q(`SELECT job, deleted FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1`, [t])).toEqual([{ job: 'idempotency_keys', deleted: 2 }]);
  });

  it('E-3 concurrency: two runners sweeping 1,200 expired keys delete each exactly once, and the audit adds up', async () => {
    const t = await tenant();
    await db.query(
      `INSERT INTO "sign"."SignIdempotencyKey" (id, tenant_id, actor_id, operation, key, request_hash, response_status, created_at)
       SELECT gen_random_uuid(), $1, gen_random_uuid(), 'remind', 'k' || g, 'h', 202, $2 FROM generate_series(1, 1200) g`,
      [t, ago(2 * DAY)],
    );
    await Promise.all([run(svc, false), run(svcB, false)]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignIdempotencyKey" WHERE tenant_id=$1`, [t])).toBe(0);
    expect(await n(`SELECT sum(deleted)::int AS n FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1 AND job='idempotency_keys'`, [t])).toBe(1200);
  });

  // ── E-4 ──

  it('E-4: processed outbox rows and finished push jobs older than 30 days are deleted; unprocessed, PENDING, recent and held rows stay', async () => {
    const t = await tenant();
    const held = await tenant({ legal_hold: true });
    const u = await user(t);
    const outbox = async (tenant_id: string, processed_at: Date | null, created_at: Date): Promise<string> => {
      const id = randomUUID();
      await db.query(`INSERT INTO "sign"."SignNotificationOutbox" (id, tenant_id, envelope_id, kind, actor_type, processed_at, created_at) VALUES ($1,$2,$3,'SIGNED','SIGNER',$4,$5)`, [
        id,
        tenant_id,
        randomUUID(),
        processed_at,
        created_at,
      ]);
      return id;
    };
    const oOld = await outbox(t, ago(31 * DAY), ago(31 * DAY));
    const oRecent = await outbox(t, ago(29 * DAY), ago(29 * DAY));
    const oUnprocessed = await outbox(t, null, ago(90 * DAY));
    const oHeld = await outbox(held, ago(90 * DAY), ago(90 * DAY));

    const device = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, push_token_ciphertext, push_token_digest, app_version) VALUES ($1,$2,$3,$4,'ios','apns','c','d','1.0.0')`,
      [device, t, u, randomUUID()],
    );
    const job = async (status: string, updated_at: Date): Promise<string> => {
      const notif = randomUUID();
      await db.query(`INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key) VALUES ($1,$2,$3,'SIGNED','SENDER',$4,'x',$5)`, [
        notif,
        t,
        u,
        randomUUID(),
        `d-${notif}`,
      ]);
      const id = randomUUID();
      await db.query(`INSERT INTO "sign"."SignPushJob" (id, tenant_id, user_id, device_id, notification_id, payload_kind, status, updated_at) VALUES ($1,$2,$3,$4,$5,'SIGNED',$6,$7)`, [
        id,
        t,
        u,
        device,
        notif,
        status,
        updated_at,
      ]);
      return id;
    };
    const finishedOld = [await job('SENT', ago(31 * DAY)), await job('CANCELLED', ago(40 * DAY)), await job('FAILED', ago(31 * DAY)), await job('DEAD', ago(60 * DAY))];
    const pendingOld = await job('PENDING', ago(60 * DAY));
    const sentRecent = await job('SENT', ago(29 * DAY));

    const report = await run(svc, true);
    expect(report.notification_outbox).toBeGreaterThanOrEqual(1);
    const outboxLeft = (await q<{ id: string }>(`SELECT id::text AS id FROM "sign"."SignNotificationOutbox"`)).map((r) => r.id);
    expect(outboxLeft).not.toContain(oOld);
    for (const kept of [oRecent, oUnprocessed, oHeld]) expect(outboxLeft).toContain(kept);
    const jobsLeft = (await q<{ id: string }>(`SELECT id::text AS id FROM "sign"."SignPushJob" WHERE tenant_id=$1`, [t])).map((r) => r.id);
    for (const gone of finishedOld) expect(jobsLeft).not.toContain(gone);
    expect(jobsLeft.sort()).toEqual([pendingOld, sentRecent].sort());
    // The feed rows (E-1 convenience data) are not part of E-4.
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignUserNotification" WHERE tenant_id=$1 AND user_id=$2`, [t, u])).toBe(6);
    expect(await q(`SELECT job, deleted FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1 ORDER BY job`, [t])).toEqual([
      { job: 'notification_outbox', deleted: 1 },
      { job: 'push_jobs', deleted: 4 },
    ]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."SignRetentionSweep" WHERE tenant_id=$1`, [held])).toBe(0);
  });
});
