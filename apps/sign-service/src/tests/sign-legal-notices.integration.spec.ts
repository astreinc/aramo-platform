import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { StaticUpcomingLegalChangeSource, UPCOMING_LEGAL_CHANGE_SOURCE } from '@aramo/subscription';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// Privacy Notice 1.1 remediation E-6 — the in-service notice (v1/sign/legal/notices) on real
// Postgres 17 with the real AppModule, every module's real migrations and real RS256 sign-consumer
// tokens. The upcoming-change source is bound to a test list (the shipped default is empty):
//   - a Business account sees the Privacy Notice change, not the Personal-only one;
//   - a Personal account sees both; a change already in effect is never shown;
//   - SHOWN records the in-service delivery once (IN_SERVICE, SENT); ACKNOWLEDGED hides it for
//     that user only (another tenant's user still sees it);
//   - recording a notice that is not upcoming for the account, or a malformed body, is refused;
//   - no session → 401.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-legal-notices-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const FUTURE = '2099-01-31';

const PRIVACY = {
  key: 'aramo.privacy_notice',
  title: 'Aramo Privacy Notice',
  version: '1.1',
  effective_date: FUTURE,
  url: 'https://sign.aramo.ai/legal/privacy/1.1',
  current_version: '1.0',
  current_url: 'https://sign.aramo.ai/legal/privacy/1.0',
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — v1/sign/legal/notices (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};

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

  async function owner(kind: 'PERSONAL' | 'BUSINESS'): Promise<{ tenant: string; user: string }> {
    const tenant = randomUUID();
    const user = randomUUID();
    const slug = `n-${tenant.slice(0, 8)}`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true, now())`, [tenant, `T ${slug}`, slug, kind]);
    for (const c of kind === 'BUSINESS' ? ['core', 'sign', 'ats'] : ['core', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [tenant, c]);
    }
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Example',$3, now())`, [user, `${slug}@example.com`, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'tenant_owner'`, [m]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    return { tenant, user };
  }

  const http = () => request(app.getHttpServer());
  const notices = async (o: { tenant: string; user: string }) => http().get('/v1/sign/legal/notices').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`);
  const record = async (o: { tenant: string; user: string }, body: unknown) =>
    http().post('/v1/sign/legal/notices/record').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`).send(body as object);
  const rowsOf = async (o: { user: string }) =>
    (
      await db.query(
        `SELECT document_key, version, channel, status, tenant_id, effective_date::text AS effective_date, sent_at, acknowledged_at FROM subscription."LegalChangeNoticeDelivery" WHERE user_id = $1 ORDER BY document_key`,
        [o.user],
      )
    ).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,'tenant_owner','tenant_owner',true, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
    for (const s of OWNER_SCOPES) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = 'tenant_owner' AND s.key = $1 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [s],
      );
    }

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    delete process.env['REDIS_URL'];

    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UPCOMING_LEGAL_CHANGE_SOURCE)
      .useValue(
        new StaticUpcomingLegalChangeSource([
          { key: 'aramo.privacy_notice', version: '1.1', effective_date: FUTURE },
          { key: 'sign.personal_terms_of_service', version: '1.1', effective_date: FUTURE },
          // Already in effect: never shown.
          { key: 'aramo.acceptable_use_policy', version: '1.1', effective_date: '2020-01-01' },
        ]),
      )
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

  it('no session → 401', async () => {
    expect((await http().get('/v1/sign/legal/notices')).status).toBe(401);
    expect((await http().post('/v1/sign/legal/notices/record').send({ key: 'aramo.privacy_notice', version: '1.1', event: 'SHOWN' })).status).toBe(401);
  });

  it('a Business account sees the Privacy Notice change only; a Personal account also sees the Personal terms change', async () => {
    const b = await owner('BUSINESS');
    const p = await owner('PERSONAL');
    const rb = await notices(b);
    expect(rb.status).toBe(200);
    expect(rb.body).toEqual({ notices: [PRIVACY] });
    const rp = await notices(p);
    expect(rp.body.notices.map((n: { key: string }) => n.key)).toEqual(['aramo.privacy_notice', 'sign.personal_terms_of_service']);
    expect(rp.body.notices[1]).toMatchObject({ url: 'https://sign.aramo.ai/legal/personal-terms/1.1', current_url: 'https://sign.aramo.ai/legal/personal-terms/1.0' });
  });

  it('SHOWN records the in-service delivery once; ACKNOWLEDGED hides it for that user only', async () => {
    const a = await owner('BUSINESS');
    const other = await owner('PERSONAL');
    const shown = await record(a, { key: 'aramo.privacy_notice', version: '1.1', event: 'SHOWN' });
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ notices: [PRIVACY] });
    expect((await record(a, { key: 'aramo.privacy_notice', version: '1.1', event: 'SHOWN' })).status).toBe(200);
    let rows = await rowsOf(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ document_key: 'aramo.privacy_notice', version: '1.1', channel: 'IN_SERVICE', status: 'SENT', tenant_id: a.tenant, effective_date: FUTURE, acknowledged_at: null });
    expect(rows[0].sent_at).not.toBeNull();

    const ack = await record(a, { key: 'aramo.privacy_notice', version: '1.1', event: 'ACKNOWLEDGED' });
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({ notices: [] });
    expect((await notices(a)).body).toEqual({ notices: [] });
    rows = await rowsOf(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].acknowledged_at).not.toBeNull();
    // Idempotent: a repeated dismissal changes nothing.
    expect((await record(a, { key: 'aramo.privacy_notice', version: '1.1', event: 'ACKNOWLEDGED' })).status).toBe(200);
    expect((await rowsOf(a))[0].acknowledged_at).toEqual(rows[0].acknowledged_at);

    // Another tenant's user is unaffected.
    expect((await notices(other)).body.notices.map((n: { key: string }) => n.key)).toContain('aramo.privacy_notice');
    expect(await rowsOf(other)).toHaveLength(0);
  });

  it('a dismissal without an earlier SHOWN still records the delivery and the acknowledgement', async () => {
    const p = await owner('PERSONAL');
    const res = await record(p, { key: 'sign.personal_terms_of_service', version: '1.1', event: 'ACKNOWLEDGED' });
    expect(res.status).toBe(200);
    expect(res.body.notices.map((n: { key: string }) => n.key)).toEqual(['aramo.privacy_notice']);
    const rows = await rowsOf(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].acknowledged_at).not.toBeNull();
  });

  it('refuses a notice that is not upcoming for this account, and a malformed body — nothing written', async () => {
    const b = await owner('BUSINESS');
    const personalOnly = await record(b, { key: 'sign.personal_terms_of_service', version: '1.1', event: 'SHOWN' });
    expect(personalOnly.status).toBe(400);
    expect(personalOnly.body.error.details.reason).toBe('legal_notice_not_upcoming');
    expect((await record(b, { key: 'aramo.acceptable_use_policy', version: '1.1', event: 'SHOWN' })).status).toBe(400);
    expect((await record(b, { key: 'aramo.privacy_notice', version: '1.1', event: 'READ' })).status).toBe(400);
    expect((await record(b, { key: 'aramo.privacy_notice' })).status).toBe(400);
    expect(await rowsOf(b)).toHaveLength(0);
  });
});
