import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { LEGAL_DOCUMENTS, PERSONAL_LEGAL_DOCUMENT_KEYS } from '@aramo/subscription';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { PersonalLegalStatusService } from '../app/legal/personal-legal-status.service.js';

// Aramo Sign Personal (Free) — v1/sign/legal on real Postgres 17 with the real
// AppModule, every module's real migrations and real RS256 sign-consumer tokens:
//   - a Personal owner who accepted the current versions at signup has nothing pending;
//   - one who has not sees the three documents (title, version, Sign-host URL);
//   - POST accept records IN_APP acceptances of the exact current versions, with the
//     client address (X-Forwarded-For, one hop) and user agent, idempotently;
//   - a stale version is refused and nothing is written;
//   - Business: nothing pending, and accept is refused;
//   - no session → 401.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-legal-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const CURRENT = PERSONAL_LEGAL_DOCUMENT_KEYS.map((key) => LEGAL_DOCUMENTS.find((d) => d.key === key && d.status === 'APPROVED')!);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — v1/sign/legal (real Postgres 17)', () => {
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

  async function owner(kind: 'PERSONAL' | 'BUSINESS'): Promise<{ tenant: string; user: string; email: string }> {
    const tenant = randomUUID();
    const user = randomUUID();
    const slug = `l-${tenant.slice(0, 8)}`;
    const email = `${slug}@gmail.com`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true, now())`, [tenant, `T ${slug}`, slug, kind]);
    for (const c of kind === 'BUSINESS' ? ['core', 'sign', 'ats'] : ['core', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [tenant, c]);
    }
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Example',$3, now())`, [user, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'tenant_owner'`, [m]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    return { tenant, user, email };
  }

  async function signupAcceptance(o: { tenant: string; user: string; email: string }): Promise<void> {
    for (const d of CURRENT) {
      await db.query(
        `INSERT INTO subscription."LegalAcceptance" (id, tenant_id, user_id, subject_email, document_key, version, sha256, context, context_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,'SIGNUP',$8)`,
        [randomUUID(), o.tenant, o.user, o.email, d.key, d.version, d.sha256, randomUUID()],
      );
    }
  }

  const http = () => request(app.getHttpServer());
  const status = async (o: { tenant: string; user: string }) => http().get('/v1/sign/legal/status').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`);
  const accept = async (o: { tenant: string; user: string }, items: unknown) =>
    http()
      .post('/v1/sign/legal/accept')
      .set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`)
      .set('X-Forwarded-For', '10.0.0.9, 198.51.100.7')
      .set('User-Agent', 'LegalTest/1.0')
      .send({ accept: items });
  const rowsOf = async (o: { tenant: string; user: string }) =>
    (
      await db.query(
        `SELECT a.document_key, a.version, a.sha256, a.context, a.context_ref, o.ip, o.user_agent FROM subscription."LegalAcceptance" a LEFT JOIN subscription."LegalAcceptanceOrigin" o ON o.acceptance_id = a.id WHERE a.tenant_id = $1 AND a.user_id = $2 ORDER BY a.document_key, a.context`,
        [o.tenant, o.user],
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

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    expect((await http().get('/v1/sign/legal/status')).status).toBe(401);
    expect((await http().post('/v1/sign/legal/accept').send({ accept: [] })).status).toBe(401);
  });

  it('a Personal owner who accepted the current versions at signup has nothing pending', async () => {
    const o = await owner('PERSONAL');
    await signupAcceptance(o);
    const res = await status(o);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [] });
    expect(await module.get(PersonalLegalStatusService).pending(o.tenant, o.user)).toEqual([]);
  });

  it('a Personal owner without acceptance sees the three documents; accept records IN_APP with the client address, idempotently', async () => {
    const o = await owner('PERSONAL');
    const res = await status(o);
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([
      { key: 'sign.personal_terms_of_service', version: '1.0', url: 'https://sign.aramo.ai/legal/personal-terms/1.0', title: 'Aramo Sign Personal Terms of Service' },
      { key: 'aramo.privacy_notice', version: '1.0', url: 'https://sign.aramo.ai/legal/privacy/1.0', title: 'Aramo Privacy Notice' },
      { key: 'aramo.acceptable_use_policy', version: '1.0', url: 'https://sign.aramo.ai/legal/acceptable-use/1.0', title: 'Aramo Acceptable Use Policy' },
    ]);

    const items = CURRENT.map((d) => ({ key: d.key, version: d.version }));
    const ok = await accept(o, items);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ pending: [] });
    expect((await status(o)).body).toEqual({ pending: [] });
    const rows = await rowsOf(o);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ version: '1.0', context: 'IN_APP', context_ref: `in_app:${o.tenant}:${o.user}`, ip: '198.51.100.7', user_agent: 'LegalTest/1.0' });
      expect(r.sha256).toBe(CURRENT.find((d) => d.key === r.document_key)!.sha256);
    }
    // Idempotent: a repeat records nothing new.
    expect((await accept(o, items)).status).toBe(200);
    expect(await rowsOf(o)).toHaveLength(3);
  });

  it('a stale or unknown version is refused and nothing is written', async () => {
    const o = await owner('PERSONAL');
    const stale = await accept(o, [
      { key: 'aramo.privacy_notice', version: '1.0' },
      { key: 'sign.personal_terms_of_service', version: '0.2.1' },
    ]);
    expect(stale.status).toBe(400);
    expect(stale.body.error.details.reason).toBe('legal_version_not_current');
    expect((await accept(o, [])).status).toBe(400);
    expect((await accept(o, [{ key: 'sign.terms_of_service', version: '0.1.1' }])).status).toBe(400);
    expect(await rowsOf(o)).toHaveLength(0);
    expect((await status(o)).body.pending).toHaveLength(3);
  });

  it('Business: nothing pending, and accept is refused', async () => {
    const o = await owner('BUSINESS');
    expect((await status(o)).body).toEqual({ pending: [] });
    const res = await accept(o, CURRENT.map((d) => ({ key: d.key, version: d.version })));
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('legal_acceptance_not_applicable');
    expect(await rowsOf(o)).toHaveLength(0);
  });
});
