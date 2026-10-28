import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE, IDENTITY_RETIREMENT_PORT, PrivacyRequestService, type IdentityPoolLookup, type IdentityRetirementOutcome } from '@aramo/identity';
import { MAILER_PORT, type SendEmailInput } from '@aramo/mailer';
import { DOCUMENT_STORAGE_PORT, hashSigningToken } from '@aramo/sign';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { PrivacyWebBudget } from '../app/privacy/sign-privacy-request.service.js';
import { SignPrivacyExecutionService } from '../app/privacy/sign-privacy-execution.service.js';
import { SignPrivacyExecutionWorker } from '../app/privacy/sign-privacy-execution.worker.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §3 + §5 (Personal) — "Delete my account" with the
// identity-owned dependency inspection, END TO END on real Postgres 17 with the real
// AppModule and every module's real migrations. The identity retirement port (the one
// AWS adapter, libs/identity) is a recorded fake: its lookup answers (e) and its retire
// records the Cognito SUB it was asked to delete. Covered:
//   - Personal-only full retirement: sessions, Sign data (incl. inbox bindings), drafts,
//     tenant CLOSED, user deactivated, retire BY SUB, User.email tombstoned,
//     ExternalIdentity (+ ExternalIdentityIdp) removed, Signer rows untouched, the address
//     can sign up again;
//   - each dependency code (a), (c), (d), (e) forces the retain path (IDENTITY_RETIREMENT_REFERRED;
//     (b) cannot exist under the one-membership unique index — the inspector unit spec
//     libs/identity/src/tests/m-a8-identity-dependency-inspector.spec.ts proves it);
//     (f) (tenant or DocumentArtifact legal hold) returns the request to the queue;
//   - tenant isolation; idempotent retry after a partial failure;
//   - guest signing to the deleted address afterwards creates no account.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-m-a8-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';
const IMAGE = 'data:image/png;base64,c2F2ZWQtc2lnbmF0dXJl';
const CLEAR: IdentityPoolLookup = { status: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 0 };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — M-A8 Personal deletion with dependency inspection (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};
  const mails: SendEmailInput[] = [];
  const deletedObjects: string[] = [];
  // The recorded identity retirement port.
  const pool = {
    lookups: [] as Array<{ cognito_sub: string | null; email?: string | null }>,
    retired: [] as Array<Record<string, unknown>>,
    lookupAnswer: new Map<string, IdentityPoolLookup>(),
    retireAnswers: [] as IdentityRetirementOutcome[],
  };

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

  interface Account {
    tenant: string;
    user: string;
    email: string;
    sub: string;
    link: string;
  }

  async function personal(opts: { extraCapability?: string; legal_hold?: boolean; role?: string; idp?: 'google' | 'microsoft' } = {}): Promise<Account> {
    const tenant = randomUUID();
    const slug = `p-${tenant.slice(0, 8)}`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, legal_hold, updated_at) VALUES ($1,$2,$3,'PERSONAL','ACTIVE',true,$4, now())`, [tenant, `T ${slug}`, slug, opts.legal_hold ?? false]);
    for (const c of ['core', 'sign', ...(opts.extraCapability !== undefined ? [opts.extraCapability] : [])]) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [tenant, c]);
    }
    await db.query(`INSERT INTO identity."TenantRiskState" (tenant_id, state) VALUES ($1, 'clear')`, [tenant]);
    const user = randomUUID();
    const m = randomUUID();
    const email = `u-${user.slice(0, 8)}@gmail.com`;
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Example',$3, now())`, [user, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    for (const role of ['tenant_owner', ...(opts.role !== undefined ? [opts.role] : [])]) {
      await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, role]);
    }
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    const sub = randomUUID();
    const link = randomUUID();
    await db.query(`INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, email_snapshot, updated_at) VALUES ($1,'cognito',$2,$3,$4, now())`, [link, sub, user, email]);
    await db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1,$2)`, [link, opts.idp ?? 'google']);
    return { tenant, user, email, sub, link };
  }

  async function seedUserData(a: Account): Promise<void> {
    for (const slot of ['signature', 'initials']) {
      await db.query(`INSERT INTO "sign"."SignSavedSignature" (id, tenant_id, user_id, slot, kind, typed_name, image_data_url) VALUES ($1,$2,$3,$4,'TYPED','Pat Example',$5)`, [randomUUID(), a.tenant, a.user, slot, IMAGE]);
    }
    await db.query(`INSERT INTO "sign"."SignContact" (id, tenant_id, owner_user_id, name, email, email_key) VALUES ($1,$2,$3,'Ann','ann@example.test','ann@example.test')`, [randomUUID(), a.tenant, a.user]);
    const notification = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignUserNotification" (id, tenant_id, user_id, type, audience, envelope_id, envelope_subject, dedupe_key) VALUES ($1,$2,$3,'SIGNED','SENDER',$4,'Offer',$5)`,
      [notification, a.tenant, a.user, randomUUID(), `d-${notification}`],
    );
    await db.query(`INSERT INTO "sign"."SignNotificationPreference" (id, tenant_id, user_id) VALUES ($1,$2,$3)`, [randomUUID(), a.tenant, a.user]);
    await db.query(
      `INSERT INTO "sign"."SignPushDevice" (id, tenant_id, user_id, device_session_id, platform, provider, push_token_ciphertext, push_token_digest, app_version) VALUES ($1,$2,$3,$4,'android','fcm','cipher','digest','1.0.0')`,
      [randomUUID(), a.tenant, a.user, randomUUID()],
    );
    const rt = randomUUID();
    await db.query(
      `INSERT INTO auth_storage."RefreshToken" (id, user_id, tenant_id, consumer_type, token_hash, updated_at, expires_at) VALUES ($1,$2,$3,'sign_native',$4, now(), now() + interval '30 days')`,
      [rt, a.user, a.tenant, `h-${rt}`],
    );
    await db.query(
      `INSERT INTO auth_storage."NativeDeviceSession" (id, user_id, tenant_id, consumer_type, client_id, installation_id, platform, app_version, refresh_family_root_id, current_refresh_token_id)
       VALUES ($1,$2,$3,'sign','aramo-sign-native','inst','android','1.0.0',$4,$4)`,
      [randomUUID(), a.user, a.tenant, rt],
    );
  }

  /** A DRAFT with one OWNED document and a COMPLETED envelope in the Personal tenant. */
  async function seedEnvelopes(a: Account): Promise<{ draft: string; completed: string; key: string }> {
    const draft = randomUUID();
    const completed = randomUUID();
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by) VALUES ($1,$2,'Draft lease','DRAFT','SINGLE_SIGNATURE',$3)`, [draft, a.tenant, a.user]);
    const k = `esign/source/${a.tenant}/${draft}/${randomUUID()}`;
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, source_object_key, content_type, byte_size, title, source_sha256, ordinal) VALUES ($1,$2,$3,'OWNED',$4,'application/pdf',10,'Lease',$5,0)`,
      [randomUUID(), a.tenant, draft, k, 'a'.repeat(64)],
    );
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at) VALUES ($1,$2,'Signed NDA','COMPLETED','SINGLE_SIGNATURE',$3, now())`, [completed, a.tenant, a.user]);
    return { draft, completed, key: k };
  }

  /** An envelope of ANOTHER tenant sent to `email`, with a live signing link (raw token returned). */
  async function inboundEnvelope(email: string, status: 'SENT' | 'COMPLETED' = 'SENT'): Promise<{ tenant: string; envelope: string; signer: string; token: string }> {
    const tenant = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'Northwind Staffing',$2,'BUSINESS','ACTIVE',true, now())`, [tenant, `n-${tenant.slice(0, 8)}`]);
    const envelope = randomUUID();
    const signer = randomUUID();
    const token = `tok_${randomBytes(24).toString('hex')}`;
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Offer letter',$3,'SINGLE_SIGNATURE',$4, now(), now() + interval '30 days')`,
      [envelope, tenant, status, randomUUID()],
    );
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,$4,'Pat',1,$5)`, [signer, tenant, envelope, email, status === 'COMPLETED' ? 'SIGNED' : 'PENDING']);
    await db.query(
      `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,'ISSUED', now() + interval '7 days')`,
      [tenant, envelope, signer, hashSigningToken(token)],
    );
    return { tenant, envelope, signer, token };
  }

  async function bindInbox(a: Account, env: { tenant: string; envelope: string; signer: string }): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignRecipientBinding" (id, envelope_tenant_id, envelope_id, signer_id, user_id, user_tenant_id, email) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, env.tenant, env.envelope, env.signer, a.user, a.tenant, a.email],
    );
    return id;
  }

  const convenienceCount = (a: Account) =>
    n(
      `SELECT (SELECT count(*) FROM "sign"."SignSavedSignature" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignContact" WHERE tenant_id=$1 AND owner_user_id=$2)
            + (SELECT count(*) FROM "sign"."SignUserNotification" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignNotificationPreference" WHERE tenant_id=$1 AND user_id=$2)
            + (SELECT count(*) FROM "sign"."SignPushDevice" WHERE tenant_id=$1 AND user_id=$2) AS n`,
      [a.tenant, a.user],
    );
  const liveSessions = (user_id: string) => n(`SELECT count(*) AS n FROM auth_storage."NativeDeviceSession" WHERE user_id=$1 AND revoked_at IS NULL`, [user_id]);
  const tenantStatus = async (id: string) => (await q<{ status: string }>(`SELECT status FROM identity."Tenant" WHERE id=$1`, [id]))[0]?.status;
  const userRow = async (id: string) => (await q<{ is_active: boolean; email: string }>(`SELECT is_active, email FROM identity."User" WHERE id=$1`, [id]))[0];
  const links = (user_id: string) => n(`SELECT count(*) AS n FROM identity."ExternalIdentity" WHERE user_id=$1`, [user_id]);
  const row = async (reference: string) => (await q<Record<string, unknown>>(`SELECT * FROM identity."PrivacyRequest" WHERE reference=$1`, [reference]))[0] as Record<string, unknown>;
  const eventsOf = async (reference: string) =>
    q<{ event_type: string; to_status: string | null; payload: Record<string, unknown> }>(
      `SELECT e.event_type, e.to_status, e.payload FROM identity."PrivacyRequestEvent" e JOIN identity."PrivacyRequest" r ON r.id = e.request_id WHERE r.reference=$1 ORDER BY e.created_at, e.id`,
      [reference],
    );
  const http = () => request(app.getHttpServer());
  const deleteAccount = async (a: Account) =>
    http().post('/v1/sign/me/privacy-requests').set('Authorization', `Bearer ${await jwt(a.user, a.tenant)}`).send({ request_type: 'DELETION', confirm: 'DELETE' });

  /** Asserts the retain path: Sign data gone, identity untouched, referral recorded with `code`. */
  async function expectRetained(a: Account, reference: string, code: string): Promise<Record<string, unknown>> {
    const r = await row(reference);
    expect(r['status']).toBe('COMPLETED');
    expect(r['outcome_code']).toBe('personal_sign_data_deleted_identity_referred');
    expect(await liveSessions(a.user)).toBe(0);
    expect(await convenienceCount(a)).toBe(0);
    expect(await userRow(a.user)).toEqual({ is_active: true, email: a.email });
    expect(await links(a.user)).toBe(1);
    expect(pool.retired).toEqual([]);
    const referred = (await eventsOf(reference)).filter((e) => e.event_type === 'IDENTITY_RETIREMENT_REFERRED');
    expect(referred).toHaveLength(1);
    expect(referred[0]!.payload['dependency_codes']).toContain(code);
    const evidence = r['completion_evidence'] as Record<string, unknown>;
    expect(evidence).toMatchObject({ identity_retained: true, users_deactivated: 0, idp_retirement: 'retained' });
    expect(JSON.stringify(evidence)).not.toContain(a.email);
    expect(JSON.stringify(evidence)).not.toContain(a.sub);
    return evidence;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription', 'auth-storage', 'documents']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const role of ['tenant_owner', 'sign_sender', 'sign_admin', 'support_admin']) {
      await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,$2,$2,true, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID(), role]);
    }
    for (const s of OWNER_SCOPES) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = 'tenant_owner' AND s.key = $1 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [s],
      );
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

    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER_PORT)
      .useValue({ send: async (m: SendEmailInput) => (mails.push(m), { message_id: `m-${mails.length}` }) })
      .overrideProvider(IDENTITY_RETIREMENT_PORT)
      .useValue({
        lookup: async (i: { cognito_sub: string | null; email?: string | null }) => (pool.lookups.push(i), pool.lookupAnswer.get(i.cognito_sub ?? '') ?? CLEAR),
        retire: async (i: Record<string, unknown>) => (pool.retired.push(i), pool.retireAnswers.shift() ?? 'deleted'),
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
    process.env[FLAG] = '1';
    module.get(PrivacyWebBudget).reset();
    pool.lookups.length = 0;
    pool.retired.length = 0;
    pool.lookupAnswer.clear();
    pool.retireAnswers.length = 0;
  });

  it('Personal-only: full retirement — Sign data and inbox bindings deleted, tenant CLOSED, identity retired BY SUB, email tombstoned, links removed, evidence kept', async () => {
    const p = await personal();
    await seedUserData(p);
    const env = await seedEnvelopes(p);
    const inbound = await inboundEnvelope(p.email);
    const binding = await bindInbox(p, inbound);
    const other = await personal();
    await seedUserData(other);
    const otherBinding = await bindInbox(other, await inboundEnvelope(other.email));

    const res = await deleteAccount(p);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'COMPLETED', outcome_code: 'personal_account_deleted' });

    // Sign data: sessions, convenience data, inbox binding, draft + its stored object.
    expect(await liveSessions(p.user)).toBe(0);
    expect(await convenienceCount(p)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignRecipientBinding" WHERE id=$1`, [binding])).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE id=$1 AND deleted_at IS NOT NULL`, [env.draft])).toBe(1);
    expect(deletedObjects).toContain(env.key);
    // Kept: the completed agreement, and the Signer row of the inbound envelope (email as signed).
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignatureEnvelope" WHERE id=$1 AND status='COMPLETED' AND deleted_at IS NULL`, [env.completed])).toBe(1);
    expect(await q(`SELECT email, status FROM "sign"."Signer" WHERE id=$1`, [inbound.signer])).toEqual([{ email: p.email, status: 'PENDING' }]);
    // The account and the identity.
    expect(await tenantStatus(p.tenant)).toBe('CLOSED');
    expect(await userRow(p.user)).toEqual({ is_active: false, email: `retired+${p.user}@invalid.aramo` });
    expect(await links(p.user)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM identity."ExternalIdentityIdp" WHERE external_identity_id=$1`, [p.link])).toBe(0);
    // The identity-owned port: inspected by sub, retired by sub — nothing else (no sign-out).
    expect(pool.lookups).toEqual([{ cognito_sub: p.sub, email: p.email }]);
    expect(pool.retired).toEqual([{ cognito_sub: p.sub }]);

    const evidence = (await row(res.body.reference))['completion_evidence'] as Record<string, unknown>;
    expect(evidence).toMatchObject({
      path: 'personal',
      recipient_bindings_deleted: 1,
      drafts_deleted: 1,
      stored_objects_deleted: 1,
      tenant_closed: true,
      identity_retained: false,
      users_deactivated: 1,
      idp_retirement: 'deleted',
      email_tombstoned: 1,
      external_identities_removed: 1,
      dependencies: { dependency_codes: [], legal_hold: false, preserved: { agreements_awaiting_user: 1, completed_agreements: 1 } },
    });
    expect(JSON.stringify(evidence)).not.toContain(p.email);
    expect(JSON.stringify(evidence)).not.toContain(p.sub);
    expect((await eventsOf(res.body.reference)).map((e) => e.event_type)).not.toContain('IDENTITY_RETIREMENT_REFERRED');

    // Tenant isolation: the other Personal account is untouched.
    expect(await convenienceCount(other)).toBe(6);
    expect(await liveSessions(other.user)).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM "sign"."SignRecipientBinding" WHERE id=$1`, [otherBinding])).toBe(1);
    expect(await userRow(other.user)).toEqual({ is_active: true, email: other.email });
    expect(await tenantStatus(other.tenant)).toBe('ACTIVE');

    // The address is free again: a new account can be created for it.
    const tenant2 = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'New',$2,'PERSONAL','ACTIVE',true, now())`, [tenant2, `r-${tenant2.slice(0, 8)}`]);
    await expect(db.query(`INSERT INTO identity."User" (id, email, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [randomUUID(), p.email, tenant2])).resolves.toBeDefined();
  });

  it('(a) another product on the Personal tenant → retain; the tenant stays open', async () => {
    const p = await personal({ extraCapability: 'ats' });
    await seedUserData(p);
    const res = await deleteAccount(p);
    const evidence = await expectRetained(p, res.body.reference, 'A_OTHER_PRODUCT');
    expect(evidence).toMatchObject({ tenant_closed: false });
    expect(await tenantStatus(p.tenant)).toBe('ACTIVE');
  });

  it('(c) another Aramo user holds a federated link for the same email → retain; the Personal Sign tenant is closed', async () => {
    const p = await personal();
    await seedUserData(p);
    const otherTenant = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'Acme',$2,'BUSINESS','ACTIVE',true, now())`, [otherTenant, `a-${otherTenant.slice(0, 8)}`]);
    const twin = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [twin, `twin-${twin.slice(0, 6)}@acme.test`, otherTenant]);
    const twinLink = randomUUID();
    await db.query(`INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, email_snapshot, updated_at) VALUES ($1,'cognito',$2,$3,$4, now())`, [twinLink, randomUUID(), twin, p.email.toUpperCase()]);
    await db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1,'microsoft')`, [twinLink]);
    const res = await deleteAccount(p);
    const evidence = await expectRetained(p, res.body.reference, 'C_SHARED_IDENTITY');
    expect(evidence).toMatchObject({ tenant_closed: true });
    expect(await tenantStatus(p.tenant)).toBe('CLOSED');
  });

  it('(d) a platform role held by the user → retain', async () => {
    const p = await personal({ role: 'support_admin' });
    const res = await deleteAccount(p);
    await expectRetained(p, res.body.reference, 'D_PLATFORM_ROLE');
  });

  it('(e) Cognito pool: a linked provider, another pool user with the email, or an unreadable pool → retain', async () => {
    const cases: Array<IdentityPoolLookup> = [
      { status: 'ok', subject_found: true, linked_providers: 1, other_users_same_email: 0 },
      { status: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 1 },
      { status: 'not_configured' },
      { status: 'failed' },
    ];
    for (const answer of cases) {
      const p = await personal();
      pool.lookupAnswer.set(p.sub, answer);
      const res = await deleteAccount(p);
      const evidence = await expectRetained(p, res.body.reference, 'E_COGNITO_POOL');
      expect((evidence['dependencies'] as Record<string, unknown>)['cognito_pool']).toMatchObject({ status: answer.status === 'ok' ? 'linked' : 'unverified' });
    }
  });

  it('(f) a legal hold on the tenant or on any DocumentArtifact of it → nothing executed; back to the queue', async () => {
    const held = await personal({ legal_hold: true });
    await seedUserData(held);
    const r1 = await deleteAccount(held);
    expect(r1.body.status).toBe('DATA_INVENTORY');

    const doc = await personal();
    await seedUserData(doc);
    await db.query('BEGIN');
    await db.query(`SET LOCAL session_replication_role = replica`);
    await db.query(
      `INSERT INTO documents."DocumentArtifact" (id, tenant_id, revision_id, document_id, artifact_role, storage_provider, storage_locator, mime_type, byte_size, sha256, immutability_state, retention_class, legal_hold, created_by)
       VALUES ($1,$2,$3,$4,'EXECUTED','s3','k','application/pdf',1,$5,'FROZEN','standard',true,$6)`,
      [randomUUID(), doc.tenant, randomUUID(), randomUUID(), 'b'.repeat(64), doc.user],
    );
    await db.query('COMMIT');
    const requests = module.get(PrivacyRequestService);
    const r2 = await deleteAccount(doc);
    // The request service saw no TENANT hold, moved it to EXECUTING; the execution found the document hold.
    expect((await row(r2.body.reference))['status']).toBe('DATA_INVENTORY');
    const holdEvents = (await eventsOf(r2.body.reference)).filter((e) => e.event_type === 'LEGAL_HOLD');
    expect(holdEvents.map((e) => e.payload['reason'])).toContain('document_legal_hold');
    for (const a of [held, doc]) {
      expect(await liveSessions(a.user)).toBe(1);
      expect(await userRow(a.user)).toEqual({ is_active: true, email: a.email });
      expect(await links(a.user)).toBe(1);
      expect(await tenantStatus(a.tenant)).toBe('ACTIVE');
    }
    expect(pool.retired).toEqual([]);
    expect((await requests.findByReference(r2.body.reference))?.status).toBe('DATA_INVENTORY');
  });

  it('idempotent retry: a failed identity retirement leaves the request EXECUTING with the link intact; the retry completes; a re-run after the tombstone skips the identity steps', async () => {
    const p = await personal();
    await seedUserData(p);
    pool.retireAnswers.push('failed');
    const res = await deleteAccount(p);
    expect(res.status).toBe(201);
    const ref = res.body.reference as string;
    expect((await row(ref))['status']).toBe('EXECUTING');
    expect((await eventsOf(ref)).map((e) => e.event_type)).toContain('EXECUTION_FAILED');
    // Steps before the retirement are done; the subject link that names the sub is kept.
    expect(await liveSessions(p.user)).toBe(0);
    expect(await userRow(p.user)).toEqual({ is_active: false, email: p.email });
    expect(await links(p.user)).toBe(1);
    expect(await tenantStatus(p.tenant)).toBe('CLOSED');

    // The worker retries: the pool user is gone now (answer: not_found) — the retry completes.
    pool.retireAnswers.push('not_found');
    expect(await module.get(SignPrivacyExecutionWorker).tick()).toBe(1);
    expect((await row(ref))['status']).toBe('COMPLETED');
    expect(await userRow(p.user)).toEqual({ is_active: false, email: `retired+${p.user}@invalid.aramo` });
    expect(await links(p.user)).toBe(0);
    expect(pool.retired).toEqual([{ cognito_sub: p.sub }, { cognito_sub: p.sub }]);
    expect((await row(ref))['completion_evidence']).toMatchObject({ idp_retirement: 'not_found', email_tombstoned: 1, external_identities_removed: 1, users_deactivated: 0 });

    // A crash after the tombstone but before COMPLETED: the re-run completes without
    // touching the identity again (no lookup by a sub that is gone, no retire).
    const q2 = await personal();
    const res2 = await deleteAccount(q2);
    expect(res2.body.status).toBe('COMPLETED');
    const requests = module.get(PrivacyRequestService);
    const id2 = (await requests.findByReference(res2.body.reference))!.id;
    await db.query(`ALTER TABLE identity."PrivacyRequest" DISABLE TRIGGER USER`);
    await db.query(`UPDATE identity."PrivacyRequest" SET status='EXECUTING', completed_at=NULL WHERE id=$1`, [id2]);
    await db.query(`ALTER TABLE identity."PrivacyRequest" ENABLE TRIGGER USER`);
    pool.retired.length = 0;
    const again = await module.get(SignPrivacyExecutionService).execute(id2);
    expect(again.status).toBe('completed');
    expect(pool.retired).toEqual([]);
    expect((await row(res2.body.reference))['completion_evidence']).toMatchObject({ idp_retirement: 'already_retired', email_tombstoned: 0, users_deactivated: 0 });
  });

  it('tenant isolation: a request whose subject no longer belongs to its tenant is held, nothing executed', async () => {
    const p = await personal();
    await seedUserData(p);
    process.env[FLAG] = '0';
    const res = await deleteAccount(p);
    expect(res.body.status).toBe('DATA_INVENTORY');
    process.env[FLAG] = '1';
    const requests = module.get(PrivacyRequestService);
    const id = (await requests.findByReference(res.body.reference))!.id;
    await db.query(`ALTER TABLE identity."PrivacyRequest" DISABLE TRIGGER USER`);
    await db.query(`UPDATE identity."PrivacyRequest" SET subject_tenant_id=$2 WHERE id=$1`, [id, randomUUID()]);
    await db.query(`ALTER TABLE identity."PrivacyRequest" ENABLE TRIGGER USER`);
    await requests.transition(id, 'EXECUTING', { actor_type: 'OPERATOR', actor_id: randomUUID() });
    const out = await module.get(SignPrivacyExecutionService).execute(id);
    expect(out.status).toBe('held');
    expect((await eventsOf(res.body.reference)).map((e) => e.event_type)).toContain('SUBJECT_MISMATCH');
    expect(await liveSessions(p.user)).toBe(1);
    expect(await userRow(p.user)).toEqual({ is_active: true, email: p.email });
    expect(pool.lookups).toEqual([]);
    expect(pool.retired).toEqual([]);
  });

  it('guest signing to the deleted address afterwards creates no account', async () => {
    const p = await personal();
    const res = await deleteAccount(p);
    expect(res.body.status).toBe('COMPLETED');
    const counts = async () => ({
      users: await n(`SELECT count(*) AS n FROM identity."User"`),
      memberships: await n(`SELECT count(*) AS n FROM identity."UserTenantMembership"`),
      links: await n(`SELECT count(*) AS n FROM identity."ExternalIdentity"`),
      tenants: await n(`SELECT count(*) AS n FROM identity."Tenant"`),
      bindings: await n(`SELECT count(*) AS n FROM "sign"."SignRecipientBinding"`),
    });
    const inbound = await inboundEnvelope(p.email);
    const before = await counts();

    const ex = await http().post('/v1/sign/signing/exchange').send({ token: inbound.token });
    expect(ex.status).toBe(200);
    const text = (await http().post('/v1/sign/signing/disclosure-text').send({ token: inbound.token })).body;
    expect((await http().post('/v1/sign/signing/disclosure').send({ token: inbound.token, disclosure_version: text.disclosure_version, disclosure_text_hash: text.text_sha256 })).status).toBe(200);
    expect((await http().post('/v1/sign/signing/decline').send({ token: inbound.token, reason: 'Not mine' })).status).toBe(200);

    expect(await counts()).toEqual(before);
    expect(await n(`SELECT count(*) AS n FROM identity."User" WHERE lower(email)=$1`, [p.email])).toBe(0);
    expect(await userRow(p.user)).toEqual({ is_active: false, email: `retired+${p.user}@invalid.aramo` });
  });
});
