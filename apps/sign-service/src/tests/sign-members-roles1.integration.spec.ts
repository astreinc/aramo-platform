import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// ROLES-1 PR-3 (Directive v1.0 LOCKED §1, §3.5, §4.3, §8; Conforming Amendments 4 and 6)
// — Sign member administration on real Postgres 17 with the real AppModule, the real
// migrations (incl. the PR-1 last-owner trigger) and real RS256 sign-consumer tokens:
//   - the Sign Owner role is retired: the assignable roles are Admin / Sender / Viewer and
//     the sign_owner key is refused (400), even though its (inactive) row exists;
//   - organization-role holders are listed with their organization role
//     (tenant_owner over tenant_admin) — the Sign Owner / Admin equivalents;
//   - the last tenant_owner cannot be demoted through Sign members: organization roles are
//     carried over by every change, and the owner count never drops.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-members-roles1-test';
const TENANT = randomUUID();
const OWNER = randomUUID();
const ORG_ADMIN = randomUUID();
const SIGN_ADMIN = randomUUID();
const RECRUITER = randomUUID();
const OWNER_SIGN_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ROLES-1 PR-3 — Sign members on the organization role model (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};
  const memberships = new Map<string, string>();

  const jwt = (sub: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: 'sign', tenant_id: TENANT, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };

  async function role(roleKey: string, scopes: readonly string[], active = true): Promise<void> {
    await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1,$2,$2,$3, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID(), roleKey, active]);
    for (const s of scopes) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = $1 AND s.key = $2 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [roleKey, s],
      );
    }
  }
  async function member(userId: string, email: string, roleKeys: readonly string[]): Promise<void> {
    const m = randomUUID();
    memberships.set(userId, m);
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [userId, email, TENANT]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, userId, TENANT]);
    for (const k of roleKeys) {
      await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, k]);
    }
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [TENANT, userId]);
  }
  const keysOf = async (userId: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."Role" r ON r.id = mr.role_id WHERE mr.membership_id = $1 ORDER BY r.key`,
        [memberships.get(userId)],
      )
    ).rows.map((r: { key: string }) => r.key);
  const activeOwners = async (): Promise<number> =>
    (
      await db.query(
        `SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole" mr JOIN identity."Role" r ON r.id = mr.role_id JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id WHERE r.key = 'tenant_owner' AND m.tenant_id = $1 AND m.is_active`,
        [TENANT],
      )
    ).rows[0].n;

  const http = () => request(app.getHttpServer());
  const put = async (as: string, target: string, sign_role: unknown) =>
    http().put(`/v1/sign/sender/members/${target}/sign-role`).set('Authorization', `Bearer ${await jwt(as)}`).send({ sign_role });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'Roles Co','roles-co','BUSINESS','ACTIVE',true, now())`, [TENANT]);
    for (const c of ['core', 'ats', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [TENANT, c]);
    }
    await role('tenant_owner', OWNER_SIGN_SCOPES);
    await role('tenant_admin', ESIGN_ROLE_PERMISSIONS.sign_admin);
    await role('sign_admin', ESIGN_ROLE_PERMISSIONS.sign_admin);
    await role('sign_sender', ESIGN_ROLE_PERMISSIONS.sign_sender);
    await role('sign_viewer', ESIGN_ROLE_PERMISSIONS.sign_viewer);
    await role('recruiter', ['talent:read']);
    // The retired row, as the ROLES-1 PR-2 migration / seed leaves it: present, inactive.
    await role('sign_owner', OWNER_SIGN_SCOPES, false);
    await member(OWNER, 'olive@roles.test', ['tenant_owner', 'tenant_admin']);
    await member(ORG_ADMIN, 'adam@roles.test', ['tenant_admin']);
    await member(SIGN_ADMIN, 'sam@roles.test', ['sign_admin']);
    await member(RECRUITER, 'rita@roles.test', ['recruiter']);

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

  it('the member list shows organization-role holders and offers only the three Sign roles', async () => {
    const res = await http().get('/v1/sign/sender/members').set('Authorization', `Bearer ${await jwt(OWNER)}`);
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { key: string }) => r.key)).toEqual(['sign_admin', 'sign_sender', 'sign_viewer']);
    const by = new Map(res.body.items.map((m: { user_id: string }) => [m.user_id, m]));
    expect(by.get(OWNER)).toMatchObject({ organization_role: 'tenant_owner', organization_role_display: 'Tenant Owner', sign_role: null });
    expect(by.get(ORG_ADMIN)).toMatchObject({ organization_role: 'tenant_admin', organization_role_display: 'Tenant Admin', sign_role: null });
    expect(by.get(SIGN_ADMIN)).toMatchObject({ organization_role: null, sign_role: 'sign_admin', sign_role_display: 'Sign Admin' });
    expect(by.get(RECRUITER)).toMatchObject({ organization_role: null, sign_role: null });
  });

  it('the retired sign_owner key is not assignable (400), even to an owner caller; nothing is written', async () => {
    const res = await put(OWNER, RECRUITER, 'sign_owner');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await keysOf(RECRUITER)).toEqual(['recruiter']);
  });

  it('a Sign Admin assigns a Sign role; every other role of the member is kept', async () => {
    const res = await put(SIGN_ADMIN, RECRUITER, 'sign_sender');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sign_role: 'sign_sender', organization_role: null });
    expect(await keysOf(RECRUITER)).toEqual(['recruiter', 'sign_sender']);
  });

  it('the last tenant_owner cannot be demoted through Sign members: tenant_owner is carried over on every change', async () => {
    expect(await activeOwners()).toBe(1);
    const lower = await put(SIGN_ADMIN, OWNER, 'sign_viewer');
    expect(lower.status).toBe(200);
    expect(lower.body).toMatchObject({ organization_role: 'tenant_owner', sign_role: 'sign_viewer' });
    expect(await keysOf(OWNER)).toEqual(['sign_viewer', 'tenant_admin', 'tenant_owner']);
    // (The owner's authz_version was bumped by the change above, so the Sign Admin acts again.)
    const removed = await put(SIGN_ADMIN, OWNER, null);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ organization_role: 'tenant_owner', sign_role: null });
    expect(await keysOf(OWNER)).toEqual(['tenant_admin', 'tenant_owner']);
    expect(await activeOwners()).toBe(1);
  });

  it('the organization administrator keeps tenant_admin through a Sign role change', async () => {
    const res = await put(SIGN_ADMIN, ORG_ADMIN, 'sign_sender');
    expect(res.status).toBe(200);
    expect(await keysOf(ORG_ADMIN)).toEqual(['sign_sender', 'tenant_admin']);
  });

  it('the DB last-owner trigger remains the backstop under the Sign members surface', async () => {
    await expect(
      db.query(`DELETE FROM identity."UserTenantMembershipRole" mr USING identity."Role" r WHERE r.id = mr.role_id AND r.key = 'tenant_owner' AND mr.membership_id = $1`, [memberships.get(OWNER)]),
    ).rejects.toThrow(/tenant_last_owner/);
    expect(await activeOwners()).toBe(1);
  });
});
