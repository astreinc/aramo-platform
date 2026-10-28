import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE, IDENTITY_RETIREMENT_PORT, PrivacyRequestService } from '@aramo/identity';
import { MAILER_PORT, type SendEmailInput } from '@aramo/mailer';
import { DOCUMENT_STORAGE_PORT } from '@aramo/sign';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { PrivacyWebBudget } from '../app/privacy/sign-privacy-request.service.js';
import { SignPrivacyExecutionWorker } from '../app/privacy/sign-privacy-execution.worker.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3 (R-1..R-4, R-17) — privacy requests and the
// staged deletion execution, on real Postgres 17 with the real AppModule, every
// module's real migrations (incl. identity 20261030030000_privacy_requests and the
// auth_storage native sessions) and real RS256 sign-consumer tokens. External edges
// are recorded fakes: the mailer (the one-time link), the IdP retirement and the
// object store. Covered:
//   - flag OFF: received, validated, inventoried and queued; the Personal close step
//     runs; nothing else is deleted; the worker does nothing;
//   - flag ON, Personal: sessions + refresh tokens revoked, convenience data and
//     drafts (with their stored objects) deleted, tenant CLOSED, identity retired;
//     completed agreements untouched; counts-only evidence;
//   - shared-identity guard: another product on the account → identity retained;
//   - Business member: referred; own data + Sign roles removed; the tenant, the
//     organization's envelopes and other members untouched;
//   - legal hold: nothing executed, back to the queue;
//   - tenant isolation of the in-app status;
//   - the public web flow: identical answers (no enumeration), single-use proof,
//     status by reference + email, email stored only protected;
//   - the events table is append-only and requests are never deleted (DB guards).

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-privacy-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';
const IMAGE = 'data:image/png;base64,c2F2ZWQtc2lnbmF0dXJl';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — privacy requests + staged deletion (M-A7 §3, real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};
  const mails: SendEmailInput[] = [];
  const retired: string[] = [];
  const deletedObjects: string[] = [];

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];
  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: number }>(sql, params))[0]?.n ?? 0);

  const jwt = (sub: string, tenant_id: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: 'sign', tenant_id, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };

  async function member(tenant: string, role: string): Promise<{ user: string; email: string }> {
    const user = randomUUID();
    const m = randomUUID();
    const email = `u-${user.slice(0, 8)}@gmail.com`;
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Example',$3, now())`, [user, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, role]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    // M-A8 — the Cognito subject link (retirement is by sub): sub = `sub-<user>`.
    await db.query(`INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, email_snapshot, updated_at) VALUES (gen_random_uuid(),'cognito',$1,$2,$3, now())`, [`sub-${user}`, user, email]);
    return { user, email };
  }

  async function account(kind: 'PERSONAL' | 'BUSINESS', opts: { legal_hold?: boolean; extraCapability?: string } = {}): Promise<{ tenant: string; user: string; email: string }> {
    const tenant = randomUUID();
    const slug = `p-${tenant.slice(0, 8)}`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, legal_hold, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true,$5, now())`, [
      tenant,
      `T ${slug}`,
      slug,
      kind,
      opts.legal_hold ?? false,
    ]);
    const caps = kind === 'BUSINESS' ? ['core', 'sign', 'ats'] : ['core', 'sign'];
    if (opts.extraCapability !== undefined) caps.push(opts.extraCapability);
    for (const c of caps) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [tenant, c]);
    }
    if (kind === 'PERSONAL') await db.query(`INSERT INTO identity."TenantRiskState" (tenant_id, state) VALUES ($1, 'clear')`, [tenant]);
    const owner = await member(tenant, kind === 'PERSONAL' ? 'tenant_owner' : 'sign_sender');
    return { tenant, ...owner };
  }

  // One of each convenience row, one live native session (+ its refresh token) and one
  // browser Sign refresh token for (tenant, user).
  async function seedUserData(tenant_id: string, user_id: string): Promise<void> {
    for (const slot of ['signature', 'initials']) {
      await db.query(`INSERT INTO "sign"."SignSavedSignature" (id, tenant_id, user_id, slot, kind, typed_name, image_data_url) VALUES ($1,$2,$3,$4,'TYPED','Pat Example',$5)`, [
        randomUUID(),
        tenant_id,
        user_id,
        slot,
        IMAGE,
      ]);
    }
    await db.query(`INSERT INTO "sign"."SignContact" (id, tenant_id, owner_user_id, name, email, email_key) VALUES ($1,$2,$3,'Ann','ann@example.test','ann@example.test')`, [randomUUID(), tenant_id, user_id]);
    const notification = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key) VALUES ($1,$2,$3,'SIGNED','SENDER',$4,'Offer',$5)`,
      [notification, tenant_id, user_id, randomUUID(), `d-${notification}`],
    );
    await db.query(`INSERT INTO "sign"."SignNotificationPreference" (id, tenant_id, user_id) VALUES ($1,$2,$3)`, [randomUUID(), tenant_id, user_id]);
    await db.query(
      `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, push_token_ciphertext, push_token_digest, app_version) VALUES ($1,$2,$3,$4,'android','fcm','cipher','digest','1.0.0')`,
      [randomUUID(), tenant_id, user_id, randomUUID()],
    );
    const rt = randomUUID();
    await db.query(
      `INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ($1,$2,$3,'sign_native',$4, now(), now() + interval '30 days')`,
      [rt, user_id, tenant_id, `h-${rt}`],
    );
    await db.query(
      `INSERT INTO auth_storage."NativeDeviceSession" (id, user_id, tenant_id, consumer_type, client_id, installation_id, platform, app_version, refresh_family_root_id, current_refresh_token_id)
       VALUES ($1,$2,$3,'sign','aramo-sign-native','inst','android','1.0.0',$4,$4)`,
      [randomUUID(), user_id, tenant_id, rt],
    );
    const web = randomUUID();
    await db.query(`INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ($1,$2,$3,'sign',$4, now(), now() + interval '30 days')`, [
      web,
      user_id,
      tenant_id,
      `h-${web}`,
    ]);
  }

  /** A DRAFT with one OWNED document, and a COMPLETED envelope. */
  async function seedEnvelopes(tenant_id: string, user_id: string): Promise<{ draft: string; completed: string; key: string }> {
    const draft = randomUUID();
    const completed = randomUUID();
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by) VALUES ($1,$2,'Draft lease','DRAFT','SINGLE_SIGNATURE',$3)`, [draft, tenant_id, user_id]);
    const k = `esign/source/${tenant_id}/${draft}/${randomUUID()}`;
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, source_object_key, content_type, byte_size, title, source_sha256, ordinal) VALUES ($1,$2,$3,'OWNED',$4,'application/pdf',10,'Lease',$5,0)`,
      [randomUUID(), tenant_id, draft, k, 'a'.repeat(64)],
    );
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at) VALUES ($1,$2,'Signed NDA','COMPLETED','SINGLE_SIGNATURE',$3, now())`, [
      completed,
      tenant_id,
      user_id,
    ]);
    return { draft, completed, key: k };
  }

  const convenienceCount = (tenant_id: string, user_id: string) =>
    n(
      `SELECT (SELECT count(*) FROM "sign"."SignSavedSignature" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignContact" WHERE tenant_id=$1 AND owner_user_id=$2)
            + (SELECT count(*) FROM "sign"."SignUserNotification" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignNotificationPreference" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignPushDevice" WHERE tenant_id=$1 AND user_id=$2) AS n`,
      [tenant_id, user_id],
    );
  const liveSessions = (user_id: string) => n(`SELECT count(*) AS n FROM auth_storage."NativeDeviceSession" WHERE user_id=$1 AND revoked_at IS NULL`, [user_id]);
  const liveTokens = (user_id: string) => n(`SELECT count(*) AS n FROM auth_storage."RefreshToken" WHERE user_id=$1 AND revoked_at IS NULL`, [user_id]);
  const tenantStatus = async (id: string) => (await q<{ status: string }>(`SELECT status FROM identity."Tenant" WHERE id=$1`, [id]))[0]?.status;
  const userActive = async (id: string) => (await q<{ is_active: boolean }>(`SELECT is_active FROM identity."User" WHERE id=$1`, [id]))[0]?.is_active;
  const riskState = async (id: string) => (await q<{ state: string }>(`SELECT state FROM identity."TenantRiskState" WHERE tenant_id=$1`, [id]))[0]?.state;
  const events = async (reference: string) =>
    q<{ event_type: string; from_status: string | null; to_status: string | null }>(
      `SELECT e.event_type, e.from_status, e.to_status FROM identity."PrivacyRequestEvent" e JOIN identity."PrivacyRequest" r ON r.id = e.request_id WHERE r.reference=$1 ORDER BY e.created_at, e.id`,
      [reference],
    );
  const row = async (reference: string) => (await q<Record<string, unknown>>(`SELECT * FROM identity."PrivacyRequest" WHERE reference=$1`, [reference]))[0] as Record<string, unknown>;

  const http = () => request(app.getHttpServer());
  const create = async (o: { tenant: string; user: string }, body: object) => http().post('/v1/sign/me/privacy-requests').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`).send(body);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription', 'auth-storage']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const role of ['tenant_owner', 'sign_sender', 'sign_admin']) {
      await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,$2,$2,true, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID(), role]);
    }
    for (const s of OWNER_SCOPES) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      for (const role of ['tenant_owner', 'sign_sender']) {
        await db.query(
          `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = $2 AND s.key = $1 ON CONFLICT (role_id, scope_id) DO NOTHING`,
          [s, role],
        );
      }
    }

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'PRIVACY_REQUEST_EMAIL_KEY', 'ARAMO_SIGN_BASE_URL', FLAG]) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    process.env['PRIVACY_REQUEST_EMAIL_KEY'] = randomBytes(32).toString('base64');
    process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
    delete process.env['REDIS_URL'];
    delete process.env[FLAG];

    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER_PORT)
      .useValue({ send: async (m: SendEmailInput) => (mails.push(m), { message_id: `m-${mails.length}` }) })
      .overrideProvider(IDENTITY_RETIREMENT_PORT)
      // M-A8 §3.5 — the identity-owned port: (e) lookup answers clear; retire is by Cognito sub.
      .useValue({
        lookup: async () => ({ status: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 0 }),
        retire: async (i: { cognito_sub: string }) => (retired.push(i.cognito_sub), 'deleted'),
      })
      .overrideProvider(DOCUMENT_STORAGE_PORT)
      .useValue({
        putOwnedSource: async () => {
          throw new Error('not used');
        },
        getOwnedSource: async () => {
          throw new Error('not used');
        },
        deleteOwnedSource: async (k: string) => void deletedObjects.push(k),
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
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

  beforeEach(() => {
    delete process.env[FLAG];
    module.get(PrivacyWebBudget).reset();
  });

  it('no session → 401 on the in-app routes', async () => {
    expect((await http().get('/v1/sign/me/privacy-requests')).status).toBe(401);
    expect((await http().post('/v1/sign/me/privacy-requests').send({ confirm: 'DELETE' })).status).toBe(401);
  });

  it('flag OFF — Personal deletion is received, validated, inventoried and queued; only the close step runs; the worker does nothing', async () => {
    const p = await account('PERSONAL');
    await seedUserData(p.tenant, p.user);
    const env = await seedEnvelopes(p.tenant, p.user);

    const unconfirmed = await create(p, { request_type: 'DELETION' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.details.reason).toBe('deletion_confirmation_required');

    const res = await create(p, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ request_type: 'DELETION', subject_kind: 'ACCOUNT_HOLDER', channel: 'IN_APP', status: 'DATA_INVENTORY', referred_to_organization: false, privacy_contact: 'privacy@aramo.ai' });
    expect(res.body.reference).toMatch(/^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Date(res.body.due_at).getTime() - new Date(res.body.created_at).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(res.body.retained.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['signing_evidence', 'legal_acceptances', 'security_logs', 'abuse_reports', 'legal_hold']));

    const r = await row(res.body.reference);
    expect(r['inventory']).toMatchObject({ native_sessions_active: 1, refresh_tokens_active: 2, saved_signatures: 2, contacts: 1, push_devices: 1, draft_envelopes: 1, completed_envelopes: 1, legal_hold: false });
    expect((await events(res.body.reference)).map((e) => e.to_status)).toEqual(['RECEIVED', 'IDENTITY_VALIDATED', 'DATA_INVENTORY', 'DATA_INVENTORY']);

    // The close step: sending stops and convenience data is purged …
    expect(await riskState(p.tenant)).toBe('closed');
    expect(await convenienceCount(p.tenant, p.user)).toBe(0);
    // … and nothing else: sessions, drafts, tenant, identity untouched.
    expect(await liveSessions(p.user)).toBe(1);
    expect(await liveTokens(p.user)).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE id=$1 AND deleted_at IS NULL`, [env.draft])).toBe(1);
    expect(await tenantStatus(p.tenant)).toBe('ACTIVE');
    expect(await userActive(p.user)).toBe(true);
    expect(retired).not.toContain(`sub-${p.user}`);

    // One open request per type: a repeat answers it.
    const again = await create(p, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(again.status).toBe(200);
    expect(again.body.reference).toBe(res.body.reference);

    expect(await module.get(SignPrivacyExecutionWorker).tick()).toBe(0);
    const list = await http().get('/v1/sign/me/privacy-requests').set('Authorization', `Bearer ${await jwt(p.user, p.tenant)}`);
    expect(list.body.items.map((i: { reference: string }) => i.reference)).toEqual([res.body.reference]);
  });

  it('tenant isolation — another user (or another organization) cannot read the request', async () => {
    const p = await account('PERSONAL');
    const mine = await create(p, { request_type: 'ACCESS' });
    expect(mine.status).toBe(201);
    expect(mine.body.status).toBe('DATA_INVENTORY');
    const own = await http().get(`/v1/sign/me/privacy-requests/${mine.body.reference}`).set('Authorization', `Bearer ${await jwt(p.user, p.tenant)}`);
    expect(own.status).toBe(200);
    const other = await account('BUSINESS');
    const res = await http().get(`/v1/sign/me/privacy-requests/${mine.body.reference}`).set('Authorization', `Bearer ${await jwt(other.user, other.tenant)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.details.reason).toBe('privacy_request_not_found');
  });

  it('flag ON — Personal deletion executes the §3.2 Personal column with counts-only evidence', async () => {
    process.env[FLAG] = '1';
    const p = await account('PERSONAL');
    await seedUserData(p.tenant, p.user);
    const env = await seedEnvelopes(p.tenant, p.user);
    const before = { events: await n(`SELECT count(*) AS n FROM "sign"."SignatureEvent" WHERE envelope_id=$1`, [env.completed]) };

    const res = await create(p, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'COMPLETED', outcome_code: 'personal_account_deleted' });

    expect(await liveSessions(p.user)).toBe(0);
    expect(await liveTokens(p.user)).toBe(0);
    expect(await convenienceCount(p.tenant, p.user)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE id=$1 AND deleted_at IS NOT NULL`, [env.draft])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM "sign"."EnvelopeDocument" WHERE envelope_id=$1`, [env.draft])).toBe(0);
    expect(deletedObjects).toContain(env.key);
    // Completed agreement and its evidence follow the retention rules: untouched.
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE id=$1 AND status='COMPLETED' AND deleted_at IS NULL`, [env.completed])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEvent" WHERE envelope_id=$1`, [env.completed])).toBe(before.events);
    expect(await riskState(p.tenant)).toBe('closed');
    expect(await tenantStatus(p.tenant)).toBe('CLOSED');
    expect(await userActive(p.user)).toBe(false);
    expect(retired).toContain(`sub-${p.user}`);

    const r = await row(res.body.reference);
    expect(r['completion_evidence']).toMatchObject({
      path: 'personal',
      device_sessions_revoked: 1,
      refresh_tokens_revoked: 2,
      saved_signatures_deleted: 2,
      contacts_deleted: 1,
      drafts_deleted: 1,
      stored_objects_deleted: 1,
      tenant_closed: true,
      identity_retained: false,
      users_deactivated: 1,
      idp_retirement: 'deleted',
    });
    // Counts only: no email, name or token anywhere in the evidence or the events.
    const evidence = JSON.stringify(r['completion_evidence']) + JSON.stringify(await q(`SELECT payload FROM identity."PrivacyRequestEvent" WHERE request_id=$1`, [r['id']]));
    expect(evidence).not.toContain(p.email);
    expect((await events(res.body.reference)).map((e) => e.to_status)).toEqual(['RECEIVED', 'IDENTITY_VALIDATED', 'DATA_INVENTORY', 'EXECUTING', 'COMPLETED']);
  });

  it('flag ON — shared-identity guard: another product on the account keeps the identity', async () => {
    process.env[FLAG] = '1';
    const p = await account('PERSONAL', { extraCapability: 'ats' });
    await seedUserData(p.tenant, p.user);
    const res = await create(p, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(res.body.status).toBe('COMPLETED');
    expect(await liveSessions(p.user)).toBe(0);
    expect(await userActive(p.user)).toBe(true);
    expect(retired).not.toContain(`sub-${p.user}`);
    // M-A8 §3.4 — retain path: the identity is referred with the dependency code.
    expect(res.body.outcome_code).toBe('personal_sign_data_deleted_identity_referred');
    expect((await events(res.body.reference)).map((e) => e.event_type)).toContain('IDENTITY_RETIREMENT_REFERRED');
    expect((await row(res.body.reference))['completion_evidence']).toMatchObject({ identity_retained: true, identity_retained_because: ['A_OTHER_PRODUCT'], users_deactivated: 0, idp_retirement: 'retained', tenant_closed: false });
  });

  it('flag ON — Business member: referred to the organization; own data and Sign roles removed; tenant, agreements and other members untouched', async () => {
    process.env[FLAG] = '1';
    const b = await account('BUSINESS');
    await seedUserData(b.tenant, b.user);
    const env = await seedEnvelopes(b.tenant, b.user);
    const colleague = await member(b.tenant, 'sign_sender');
    await seedUserData(b.tenant, colleague.user);

    const res = await create(b, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subject_kind: 'BUSINESS_MEMBER', status: 'COMPLETED', referred_to_organization: true, outcome_code: 'member_sign_data_removed' });
    expect(res.body.organization_decides).toContain('Your organization decides');
    expect(res.body.retained.map((r: { key: string }) => r.key)).toContain('organization_documents');
    expect((await events(res.body.reference)).map((e) => e.to_status)).toEqual(['RECEIVED', 'IDENTITY_VALIDATED', 'DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION', 'EXECUTING', 'COMPLETED']);
    expect((await row(res.body.reference))['referred_tenant_id']).toBe(b.tenant);

    expect(await liveSessions(b.user)).toBe(0);
    expect(await convenienceCount(b.tenant, b.user)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id WHERE m.user_id=$1`, [b.user])).toBe(0);
    // Never: the tenant, the organization's envelopes (draft included), the identity, a colleague.
    expect(await tenantStatus(b.tenant)).toBe('ACTIVE');
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE tenant_id=$1 AND deleted_at IS NULL`, [b.tenant])).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM "sign"."EnvelopeDocument" WHERE envelope_id=$1`, [env.draft])).toBe(1);
    expect(deletedObjects).not.toContain(env.key);
    expect(await userActive(b.user)).toBe(true);
    expect(retired).not.toContain(`sub-${b.user}`);
    expect(await convenienceCount(b.tenant, colleague.user)).toBe(6);
    expect(await liveSessions(colleague.user)).toBe(1);
  });

  it('flag ON — legal hold: nothing is executed or closed; the request waits with a LEGAL_HOLD event; an execution attempt returns it to the queue', async () => {
    process.env[FLAG] = '1';
    const p = await account('PERSONAL', { legal_hold: true });
    await seedUserData(p.tenant, p.user);
    const res = await create(p, { request_type: 'DELETION', confirm: 'DELETE' });
    expect(res.body.status).toBe('DATA_INVENTORY');
    expect((await events(res.body.reference)).map((e) => e.event_type)).toContain('LEGAL_HOLD');
    expect(await riskState(p.tenant)).toBe('clear');
    expect(await liveSessions(p.user)).toBe(1);
    expect(await convenienceCount(p.tenant, p.user)).toBe(6);

    // Even when moved to EXECUTING, the execution refuses and returns it to the queue.
    const requests = module.get(PrivacyRequestService);
    const r = await requests.findByReference(res.body.reference);
    await requests.transition(r!.id, 'EXECUTING', { actor_type: 'OPERATOR', actor_id: randomUUID() });
    await module.get(SignPrivacyExecutionWorker).tick();
    expect((await row(res.body.reference))['status']).toBe('DATA_INVENTORY');
    expect(await liveSessions(p.user)).toBe(1);
    expect(await tenantStatus(p.tenant)).toBe('ACTIVE');
  });

  it('web — identical answers for known and unknown emails; single-use proof; status by reference + email; the email is stored protected; the worker executes an operator-approved request', async () => {
    const p = await account('PERSONAL');
    await seedUserData(p.tenant, p.user);
    const unknown = `nobody-${randomUUID().slice(0, 8)}@gmail.com`;
    const mailsBefore = mails.length;

    const a = await http().post('/v1/sign/privacy-requests/start').send({ email: p.email.toUpperCase(), request_type: 'DELETION' });
    const b = await http().post('/v1/sign/privacy-requests/start').send({ email: unknown });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual({ received: true });
    expect((await http().post('/v1/sign/privacy-requests/start').send({ email: 'not-an-email' })).status).toBe(400);

    const sent = mails.slice(mailsBefore);
    expect(sent.map((m) => m.to)).toEqual([p.email, unknown]);
    const link = /https:\/\/sign\.example\.test\/delete-account#token=([A-Za-z0-9_-]+)/.exec(sent[0]!.text ?? '');
    expect(link).not.toBeNull();
    const token = link![1]!;
    // The token is never stored in clear.
    expect(await n(`SELECT count(*) AS n FROM identity."PrivacyRequestEmailProof" WHERE token_hash=$1`, [token])).toBe(0);

    const v = await http().post('/v1/sign/privacy-requests/verify').send({ token });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ channel: 'WEB', subject_kind: 'ACCOUNT_HOLDER', status: 'DATA_INVENTORY', request_type: 'DELETION' });
    // A reload with the same token answers the same request; a made-up token is refused.
    expect((await http().post('/v1/sign/privacy-requests/verify').send({ token })).body.reference).toBe(v.body.reference);
    const forged = await http().post('/v1/sign/privacy-requests/verify').send({ token: randomBytes(32).toString('base64url') });
    expect(forged.status).toBe(404);
    expect(forged.body.error.details.reason).toBe('privacy_link_invalid');

    const stored = await row(v.body.reference);
    expect(String(stored['contact_email_ciphertext'])).not.toContain(p.email);
    expect(String(stored['contact_email_hash'])).not.toContain(p.email);
    expect(stored['subject_user_id']).toBe(p.user);
    expect(stored['inventory']).toMatchObject({ account_found: true, saved_signatures: 2 });

    const ok = await http().post('/v1/sign/privacy-requests/status').send({ reference: v.body.reference.toLowerCase(), email: p.email });
    expect(ok.status).toBe(200);
    expect(ok.body.reference).toBe(v.body.reference);
    const wrong = await http().post('/v1/sign/privacy-requests/status').send({ reference: v.body.reference, email: unknown });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error.details.reason).toBe('privacy_request_not_found');

    // A web request is never executed by itself, even with the flag on.
    process.env[FLAG] = '1';
    expect(await module.get(SignPrivacyExecutionWorker).tick()).toBe(0);
    expect(await liveSessions(p.user)).toBe(1);
    // The operator approves execution (platform-admin moves it to EXECUTING); the worker runs it.
    const requests = module.get(PrivacyRequestService);
    await requests.transition(String(stored['id']), 'EXECUTING', { actor_type: 'OPERATOR', actor_id: randomUUID() });
    expect(await module.get(SignPrivacyExecutionWorker).tick()).toBe(1);
    expect((await row(v.body.reference))['status']).toBe('COMPLETED');
    expect(await liveSessions(p.user)).toBe(0);
    expect(await tenantStatus(p.tenant)).toBe('CLOSED');
  });

  it('DB guards — events are append-only; requests are never deleted; a terminal status is final', async () => {
    const p = await account('PERSONAL');
    const res = await create(p, { request_type: 'EXPORT' });
    const r = await row(res.body.reference);
    await expect(db.query(`UPDATE identity."PrivacyRequestEvent" SET event_type='X' WHERE request_id=$1`, [r['id']])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM identity."PrivacyRequestEvent" WHERE request_id=$1`, [r['id']])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM identity."PrivacyRequest" WHERE id=$1`, [r['id']])).rejects.toThrow(/never deleted/);
    await expect(db.query(`UPDATE identity."PrivacyRequest" SET reference='PR-0000-0000-0000' WHERE id=$1`, [r['id']])).rejects.toThrow(/immutable/);
    await db.query(`UPDATE identity."PrivacyRequest" SET status='CANCELLED' WHERE id=$1`, [r['id']]);
    await expect(db.query(`UPDATE identity."PrivacyRequest" SET status='EXECUTING' WHERE id=$1`, [r['id']])).rejects.toThrow(/final/);
    await expect(db.query(`INSERT INTO identity."PrivacyRequest" (id, reference, request_type, subject_kind, channel, status, due_at) VALUES ($1,'PR-AAAA-AAAA-AAAA','DELETION','GUEST_SIGNER','OPERATOR','BOGUS', now() + interval '30 days')`, [randomUUID()])).rejects.toThrow(/check/i);
  });
});
