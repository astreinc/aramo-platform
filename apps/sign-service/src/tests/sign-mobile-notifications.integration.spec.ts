import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { EsignRepository, EsignService, PrismaService } from '@aramo/sign';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { NotificationFanoutService } from '../app/push/notification-fanout.service.js';
import { PushDeliveryService } from '../app/push/push-delivery.service.js';
import { PUSH_DELIVERY_PORT } from '../app/push/push-delivery.port.js';
import type { LogPushDelivery } from '../app/push/push-delivery.adapters.js';
import { ConvenienceDataPurgeService } from '../app/push/convenience-data-purge.service.js';
import { DEVICE_SESSION_LIVENESS, type DeviceSessionLiveness } from '../app/push/device-session-liveness.js';

// Aramo Sign Mobile — notification feed, devices, preferences and push, END TO END
// against Postgres (M-A3 §1, §2, §9): ledger events land in the notification outbox
// in their own transaction; the fan-out writes feed rows only for the right users
// (sender; CLAIMED recipient only), dedupes, honours preferences and enqueues
// pushes per live device; the routes are owner- and tenant-isolated; devices attach
// only to the token's own dsid; revocation cancels queued pushes and is re-checked
// just before sending; account close purges the convenience data with a counts-only
// audit. Push delivery uses the `log` adapter (no provider is contacted).

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-mobile-notifications-test';
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const SAM = randomUUID(); // sender, tenant A
const BOB = randomUUID(); // recipient, tenant B, claims his recipient
const CAROL = randomUUID(); // another user of tenant B
const ENVELOPE = randomUUID();
const SIGNER_BOB = randomUUID();
const SIGNER_DEE = randomUUID(); // never claimed
const BINDING = randomUUID();
const DSID_SAM = randomUUID();
const DSID_BOB = randomUUID();
const SAM_APNS = 'ab'.repeat(32);
const BOB_FCM = `fcm_${randomBytes(24).toString('hex')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign mobile — notifications, devices, preferences, push (M-A3 §1, §2, §9)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  let fanout: NotificationFanoutService;
  let delivery: PushDeliveryService;
  let push: LogPushDelivery;
  const saved: Record<string, string | undefined> = {};

  const jwt = (sub: string, tenant: string, dsid?: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { sub, actor_kind: 'user', consumer_type: 'sign', tenant_id: tenant, authz_version: 1 };
    if (dsid !== undefined) Object.assign(claims, { client: 'native', dsid });
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };
  const http = () => request(app.getHttpServer());
  const as = async (sub: string, tenant: string, dsid?: string) => `Bearer ${await jwt(sub, tenant, dsid)}`;
  const append = (event_type: string, extra: Record<string, unknown>) =>
    module.get(PrismaService, { strict: false }).$transaction((tx) =>
      module.get(EsignRepository, { strict: false }).appendEvent(tx as never, { tenant_id: TENANT_A, envelope_id: ENVELOPE, event_type, ...extra } as never),
    );
  const drain = async () => {
    const f = await fanout.processDueBatch();
    const d = await delivery.deliverDueBatch();
    return { f, d };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription', 'auth-storage']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const [id, name, kind] of [[TENANT_A, 'Northwind Staffing', 'BUSINESS'], [TENANT_B, 'Bob Personal', 'BUSINESS']] as const) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true, now())`, [id, name, `t-${id.slice(0, 8)}`, kind]);
      for (const c of ['core', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [id, c]);
    }
    for (const [id, email, tenant] of [[SAM, 'sam@northwind.test', TENANT_A], [BOB, 'bob@example.test', TENANT_B], [CAROL, 'carol@example.test', TENANT_B]] as const) {
      await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [id, email, tenant]);
      await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [randomUUID(), id, tenant]);
      await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, id]);
    }
    // A live native session = an open NativeDeviceSession whose CURRENT refresh token is
    // unrevoked and unexpired (auth-storage NativeDeviceSessionService.isActive), so each
    // seeded session gets a real current RefreshToken row.
    for (const [dsid, user, tenant, platform] of [[DSID_SAM, SAM, TENANT_A, 'ios'], [DSID_BOB, BOB, TENANT_B, 'android']] as const) {
      const rt = randomUUID();
      await db.query(
        `INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at)
         VALUES ($1,$2,$3,'sign_native',$4, now(), now() + interval '30 days')`,
        [rt, user, tenant, `seed-${rt}`],
      );
      await db.query(
        `INSERT INTO auth_storage."NativeDeviceSession" (id, user_id, tenant_id, consumer_type, client_id, installation_id, platform, app_version, refresh_family_root_id, current_refresh_token_id)
         VALUES ($1,$2,$3,'sign','aramo-sign-native',$4,$5,'1.0.0',$6,$7)`,
        [dsid, user, tenant, randomUUID(), platform, rt, rt],
      );
    }
    // Sam (tenant A) sent an envelope from the Sign console to Bob and Dee (parallel).
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Offer letter','SENT','MULTI_SIGNATURE',$3, now(), now() + interval '30 days')`,
      [ENVELOPE, TENANT_A, SAM],
    );
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,'bob@example.test','Bob Brown',1,'PENDING')`, [SIGNER_BOB, TENANT_A, ENVELOPE]);
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,'dee@example.test','Dee Diaz',2,'PENDING')`, [SIGNER_DEE, TENANT_A, ENVELOPE]);
    // Bob claimed his recipient in his inbox (S-7). Dee never did.
    await db.query(
      `INSERT INTO "sign"."SignRecipientBinding" (id, envelope_tenant_id, envelope_id, signer_id, user_id, user_tenant_id, email) VALUES ($1,$2,$3,$4,$5,$6,'bob@example.test')`,
      [BINDING, TENANT_A, ENVELOPE, SIGNER_BOB, BOB, TENANT_B],
    );

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'SIGN_PUSH_DELIVERY', 'SIGN_PUSH_TOKEN_KEY', 'SIGN_NOTIFICATION_WORKER_ENABLED']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    process.env['SIGN_PUSH_DELIVERY'] = 'log';
    process.env['SIGN_PUSH_TOKEN_KEY'] = randomBytes(32).toString('base64');
    process.env['SIGN_NOTIFICATION_WORKER_ENABLED'] = '0'; // ticks are driven by the test
    delete process.env['REDIS_URL'];
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    fanout = module.get(NotificationFanoutService);
    delivery = module.get(PushDeliveryService);
    push = module.get(PUSH_DELIVERY_PORT) as LogPushDelivery;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  it('devices attach only to the native token’s own dsid: a web token, or another user’s dsid, is refused', async () => {
    const body = { platform: 'ios', provider: 'apns', push_token: SAM_APNS, app_version: '1.0.0' };
    const web = await http().put('/v1/sign/me/devices/current').set('Authorization', await as(SAM, TENANT_A)).send(body);
    expect(web.status).toBe(403);
    expect(web.body.error.details.reason).toBe('native_session_required');
    const foreign = await http().put('/v1/sign/me/devices/current').set('Authorization', await as(CAROL, TENANT_B, DSID_SAM)).send(body);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.details.reason).toBe('session_revoked');
    const bad = await http().put('/v1/sign/me/devices/current').set('Authorization', await as(SAM, TENANT_A, DSID_SAM)).send({ ...body, push_token: 'not hex' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('invalid_push_registration');
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignPushDevice"`)).rows[0].n).toBe(0);

    expect((await http().put('/v1/sign/me/devices/current').set('Authorization', await as(SAM, TENANT_A, DSID_SAM)).send(body)).status).toBe(204);
    expect((await http().put('/v1/sign/me/devices/current').set('Authorization', await as(BOB, TENANT_B, DSID_BOB)).send({ platform: 'android', provider: 'fcm', push_token: BOB_FCM, app_version: '1.0.0' })).status).toBe(204);
    const rows = (await db.query(`SELECT user_id, tenant_id, device_session_id, push_token_ciphertext FROM "sign"."SignPushDevice" ORDER BY platform`)).rows;
    expect(rows.map((r) => [r.user_id, r.tenant_id, r.device_session_id])).toEqual([[BOB, TENANT_B, DSID_BOB], [SAM, TENANT_A, DSID_SAM]]);
    for (const r of rows) {
      expect(r.push_token_ciphertext).not.toContain(SAM_APNS);
      expect(r.push_token_ciphertext).not.toContain(BOB_FCM);
    }
  });

  it('a ledger event lands in the notification outbox in its own transaction; routine events do not', async () => {
    await append('DOCUMENT_ATTACHED', { actor_type: 'SERVICE', actor_ref: SAM });
    await append('SESSION_EXCHANGED', { signer_id: SIGNER_BOB, actor_type: 'SIGNER', actor_ref: SIGNER_BOB });
    const outbox = (await db.query(`SELECT kind, signer_id FROM "sign"."SignNotificationOutbox"`)).rows;
    expect(outbox).toEqual([{ kind: 'VIEWED', signer_id: SIGNER_BOB }]);
  });

  it('fan-out: the sender hears the view and gets one push; nobody else gets a row', async () => {
    const { f, d } = await drain();
    expect(f).toMatchObject({ claimed: 1, processed: 1, notifications: 1, push_jobs: 1 });
    expect(d).toMatchObject({ sent: 1 });
    expect(push.sent).toEqual([{ provider: 'apns', type: 'VIEWED' }]);
    const feed = await http().get('/v1/sign/me/notifications').set('Authorization', await as(SAM, TENANT_A));
    expect(feed.status).toBe(200);
    expect(feed.body.items).toEqual([expect.objectContaining({ type: 'VIEWED', envelope_id: ENVELOPE, inbox_item_id: null, envelope_subject: 'Offer letter', actor_name: 'Bob Brown', read_at: null })]);
    expect(feed.body.next_cursor).toBeNull();
    for (const [u, t] of [[BOB, TENANT_B], [CAROL, TENANT_B]] as const) {
      expect((await http().get('/v1/sign/me/notifications').set('Authorization', await as(u, t))).body.items).toEqual([]);
    }
  });

  it('dedupe + idempotency: a repeat view adds no row and no push; a processed row is never re-processed', async () => {
    await append('SESSION_EXCHANGED', { signer_id: SIGNER_BOB, actor_type: 'SIGNER', actor_ref: SIGNER_BOB });
    const { f } = await drain();
    expect(f).toMatchObject({ claimed: 1, processed: 1, push_jobs: 0 });
    expect((await drain()).f.claimed).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignUserNotification"`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignPushJob"`)).rows[0].n).toBe(1);
    expect(push.sent).toHaveLength(1);
  });

  it('a reminder reaches the CLAIMED recipient only, in his own tenant, keyed to his inbox item (never the sender’s envelope id)', async () => {
    await module.get(EsignService, { strict: false }).remindSigner(TENANT_A, ENVELOPE, SAM);
    const { f } = await drain();
    expect(f.notifications).toBe(1); // Bob claimed; Dee did not
    const bob = await http().get('/v1/sign/me/notifications').set('Authorization', await as(BOB, TENANT_B));
    expect(bob.body.items).toEqual([expect.objectContaining({ type: 'REMINDER', envelope_id: null, inbox_item_id: BINDING, actor_name: 'Northwind Staffing' })]);
    expect(JSON.stringify(bob.body)).not.toContain(ENVELOPE);
    expect(JSON.stringify(bob.body)).not.toContain(TENANT_A);
    expect(push.sent.map((s) => s.type)).toEqual(['VIEWED', 'REMINDER']);
    const row = (await db.query(`SELECT tenant_id, user_id FROM "sign"."SignUserNotification" WHERE type = 'REMINDER'`)).rows[0];
    expect(row).toEqual({ tenant_id: TENANT_B, user_id: BOB });
  });

  it('feed isolation: another user, or the same user under another tenant, cannot read or mark a notification', async () => {
    const samItem = (await http().get('/v1/sign/me/notifications').set('Authorization', await as(SAM, TENANT_A))).body.items[0].id;
    expect((await http().post(`/v1/sign/me/notifications/${samItem}/read`).set('Authorization', await as(CAROL, TENANT_B))).status).toBe(404);
    expect([403, 404]).toContain((await http().post(`/v1/sign/me/notifications/${samItem}/read`).set('Authorization', await as(SAM, TENANT_B))).status); // not Sam's tenant
    expect((await http().post(`/v1/sign/me/notifications/read-all`).set('Authorization', await as(BOB, TENANT_B))).status).toBe(204);
    expect((await db.query(`SELECT read_at FROM "sign"."SignUserNotification" WHERE id = $1`, [samItem])).rows[0].read_at).toBeNull();
    expect((await http().get('/v1/sign/me/notifications/unread-count').set('Authorization', await as(SAM, TENANT_A))).body).toEqual({ count: 1 });
    expect((await http().post(`/v1/sign/me/notifications/${samItem}/read`).set('Authorization', await as(SAM, TENANT_A))).status).toBe(204);
    expect((await http().post(`/v1/sign/me/notifications/${samItem}/read`).set('Authorization', await as(SAM, TENANT_A))).status).toBe(204); // idempotent
    expect((await http().get('/v1/sign/me/notifications/unread-count').set('Authorization', await as(SAM, TENANT_A))).body).toEqual({ count: 0 });
  });

  it('preferences: defaults, owner-only writes, and a type switched off writes the feed row but enqueues no push', async () => {
    const defaults = { signed: true, viewed: true, declined: true, signature_needed: true, reminders: true, lock_screen_subject: false };
    expect((await http().get('/v1/sign/me/notification-preferences').set('Authorization', await as(SAM, TENANT_A))).body).toEqual(defaults);
    const bad = await http().put('/v1/sign/me/notification-preferences').set('Authorization', await as(SAM, TENANT_A)).send({ viewed: false });
    expect(bad.body.error.details.reason).toBe('invalid_notification_preferences');
    const put = await http().put('/v1/sign/me/notification-preferences').set('Authorization', await as(SAM, TENANT_A)).send({ ...defaults, viewed: false });
    expect(put.status).toBe(200);
    expect((await http().get('/v1/sign/me/notification-preferences').set('Authorization', await as(CAROL, TENANT_B))).body).toEqual(defaults);
    await append('SESSION_EXCHANGED', { signer_id: SIGNER_DEE, actor_type: 'SIGNER', actor_ref: SIGNER_DEE });
    const { f } = await drain();
    expect(f).toMatchObject({ notifications: 1, push_jobs: 0 });
    expect((await http().get('/v1/sign/me/notifications?limit=1').set('Authorization', await as(SAM, TENANT_A))).body).toMatchObject({ items: [expect.objectContaining({ actor_name: 'Dee Diaz' })], next_cursor: expect.any(String) });
  });

  it('cursor paging walks the feed newest first without repeats', async () => {
    const auth = await as(SAM, TENANT_A);
    const p1 = (await http().get('/v1/sign/me/notifications?limit=1').set('Authorization', auth)).body;
    const p2 = (await http().get(`/v1/sign/me/notifications?limit=1&cursor=${p1.next_cursor}`).set('Authorization', auth)).body;
    expect(p1.items[0].actor_name).toBe('Dee Diaz');
    expect(p2.items[0].actor_name).toBe('Bob Brown');
    expect(p2.next_cursor).toBeNull();
  });

  it('the worker re-checks the device session just before sending: a session revoked after queueing gets no push', async () => {
    await module.get(EsignService, { strict: false }).remindSigner(TENANT_A, ENVELOPE, SAM, SIGNER_BOB);
    const f = await fanout.processDueBatch();
    expect(f.push_jobs).toBe(1);
    await db.query(`UPDATE auth_storage."NativeDeviceSession" SET revoked_at = now() WHERE id = $1`, [DSID_BOB]);
    const before = push.sent.length;
    const d = await delivery.deliverDueBatch();
    expect(d).toMatchObject({ sent: 0, cancelled: 1 });
    expect(push.sent.length).toBe(before);
    const dev = (await db.query(`SELECT revoked_at, push_token_ciphertext FROM "sign"."SignPushDevice" WHERE device_session_id = $1`, [DSID_BOB])).rows[0];
    expect(dev.revoked_at).not.toBeNull();
    expect(dev.push_token_ciphertext).toBeNull();
  });

  it('an OPEN device session whose current refresh token was revoked (user-wide revocation) or expired is not live', async () => {
    const live = module.get<DeviceSessionLiveness>(DEVICE_SESSION_LIVENESS, { strict: false });
    const owner = { tenant_id: TENANT_A, user_id: SAM };
    expect(await live.stateOf(DSID_SAM, owner)).toBe('live');
    const cur = (await db.query(`SELECT current_refresh_token_id AS id FROM auth_storage."NativeDeviceSession" WHERE id = $1`, [DSID_SAM])).rows[0].id;
    // A user-wide revocation (reuse cascade / logout-all) revokes the refresh token, not the session row.
    await db.query(`UPDATE auth_storage."RefreshToken" SET revoked_at = now() WHERE id = $1`, [cur]);
    expect(await live.stateOf(DSID_SAM, owner)).toBe('revoked');
    // Expired (never revoked) is not live either.
    await db.query(`UPDATE auth_storage."RefreshToken" SET revoked_at = NULL, expires_at = now() - interval '1 minute' WHERE id = $1`, [cur]);
    expect(await live.stateOf(DSID_SAM, owner)).toBe('revoked');
    await db.query(`UPDATE auth_storage."RefreshToken" SET expires_at = now() + interval '30 days' WHERE id = $1`, [cur]);
    expect(await live.stateOf(DSID_SAM, owner)).toBe('live');
  });

  it('removing a device cancels its queued pushes and deletes its token material', async () => {
    await db.query(`UPDATE "sign"."SignNotificationPreference" SET viewed = true WHERE user_id = $1`, [SAM]);
    const n = (await db.query(`SELECT id FROM "sign"."SignUserNotification" WHERE user_id = $1 LIMIT 1`, [SAM])).rows[0].id;
    const dev = (await db.query(`SELECT id FROM "sign"."SignPushDevice" WHERE device_session_id = $1`, [DSID_SAM])).rows[0].id;
    await db.query(`DELETE FROM "sign"."SignPushJob" WHERE device_id = $1`, [dev]);
    await db.query(`INSERT INTO "sign"."SignPushJob" (id, tenant_id, user_id, device_id, notification_id, payload_kind) VALUES (gen_random_uuid(),$1,$2,$3,$4,'VIEWED')`, [TENANT_A, SAM, dev, n]);
    expect((await http().delete('/v1/sign/me/devices/current').set('Authorization', await as(SAM, TENANT_A, DSID_SAM))).status).toBe(204);
    const job = (await db.query(`SELECT status FROM "sign"."SignPushJob" WHERE device_id = $1`, [dev])).rows[0];
    expect(job.status).toBe('CANCELLED');
    const row = (await db.query(`SELECT revoked_at, push_token_ciphertext, push_token_digest FROM "sign"."SignPushDevice" WHERE id = $1`, [dev])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.push_token_ciphertext).toBeNull();
    expect(row.push_token_digest).toBeNull();
    const before = push.sent.length;
    expect((await delivery.deliverDueBatch()).sent).toBe(0);
    expect(push.sent.length).toBe(before);
  });

  it('account close purges the user’s convenience data (devices, feed, preferences) with a counts-only audit; another user is untouched', async () => {
    const counts = await module.get(ConvenienceDataPurgeService).purgeForAccountClose({ tenant_id: TENANT_A, user_id: SAM });
    expect(counts).toEqual({ devices_revoked: 0, push_jobs_cancelled: 0, devices_deleted: 1, notifications_deleted: 2, preferences_deleted: 1 });
    expect((await http().get('/v1/sign/me/notifications').set('Authorization', await as(SAM, TENANT_A))).body.items).toEqual([]);
    expect((await http().get('/v1/sign/me/notifications').set('Authorization', await as(BOB, TENANT_B))).body.items).toHaveLength(2);
    const audit = (await db.query(`SELECT tenant_id, user_id, reason, devices_deleted, notifications_deleted, preferences_deleted FROM "sign"."SignConvenienceDataPurge"`)).rows;
    expect(audit).toEqual([{ tenant_id: TENANT_A, user_id: SAM, reason: 'account_closed', devices_deleted: 1, notifications_deleted: 2, preferences_deleted: 1 }]);
    // Signing evidence is untouched.
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE envelope_id = $1`, [ENVELOPE])).rows[0].n).toBeGreaterThan(0);
    // Idempotent: a repeat finds nothing.
    expect(await module.get(ConvenienceDataPurgeService).purgeForAccountClose({ tenant_id: TENANT_A, user_id: SAM })).toEqual({ devices_revoked: 0, push_jobs_cancelled: 0, devices_deleted: 0, notifications_deleted: 0, preferences_deleted: 0 });
  });
});
