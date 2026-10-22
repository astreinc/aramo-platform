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

// Aramo Sign Personal (Free) — Settings → Close account (v1/sign/account) on real
// Postgres 17 with the real AppModule, every module's real migrations and real
// RS256 sign-consumer tokens:
//   - the Personal owner sees closable; POST close needs confirm = CLOSE; the close
//     moves the risk state to `closed` with ONE identity.personal.risk.closed audit
//     event whose actor is the owner; a repeat answers the closed state, no new event;
//   - a member who is not the owner, a Business owner and a Personal account with no
//     risk state are refused with their stable reasons;
//   - no session → 401.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-account-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — v1/sign/account (real Postgres 17)', () => {
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

  async function member(tenant: string, role: string): Promise<string> {
    const user = randomUUID();
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Example',$3, now())`, [user, `u-${user.slice(0, 8)}@gmail.com`, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, role]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    return user;
  }

  async function account(kind: 'PERSONAL' | 'BUSINESS', opts: { riskState?: string | null } = {}): Promise<{ tenant: string; user: string }> {
    const tenant = randomUUID();
    const slug = `a-${tenant.slice(0, 8)}`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true, now())`, [tenant, `T ${slug}`, slug, kind]);
    for (const c of kind === 'BUSINESS' ? ['core', 'sign', 'ats'] : ['core', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [tenant, c]);
    }
    const riskState = opts.riskState === undefined ? (kind === 'PERSONAL' ? 'clear' : null) : opts.riskState;
    if (riskState !== null) await db.query(`INSERT INTO identity."TenantRiskState" (tenant_id, state) VALUES ($1, $2)`, [tenant, riskState]);
    return { tenant, user: await member(tenant, 'tenant_owner') };
  }

  const http = () => request(app.getHttpServer());
  const status = async (o: { tenant: string; user: string }) => http().get('/v1/sign/account/status').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`);
  const close = async (o: { tenant: string; user: string }, body: unknown) =>
    http().post('/v1/sign/account/close').set('Authorization', `Bearer ${await jwt(o.user, o.tenant)}`).send(body as object);
  const riskOf = async (tenant: string) => (await db.query(`SELECT state, reason, decided_by FROM identity."TenantRiskState" WHERE tenant_id = $1`, [tenant])).rows[0];
  const closedEvents = async (tenant: string) =>
    (await db.query(`SELECT actor_id, actor_type, event_payload FROM identity."IdentityAuditEvent" WHERE tenant_id = $1 AND event_type = 'identity.personal.risk.closed'`, [tenant])).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const role of ['tenant_owner', 'sign_sender']) {
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
    expect((await http().get('/v1/sign/account/status')).status).toBe(401);
    expect((await http().post('/v1/sign/account/close').send({ confirm: 'CLOSE' })).status).toBe(401);
  });

  it('the Personal owner closes the account: confirm required; risk state closed; audited with the owner as actor; idempotent', async () => {
    const o = await account('PERSONAL');
    const before = await status(o);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ closable: true, closed: false, closed_at: null });

    const unconfirmed = await close(o, { confirm: 'close' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.details.reason).toBe('account_close_confirmation_required');
    expect((await riskOf(o.tenant)).state).toBe('clear');

    const res = await close(o, { confirm: 'CLOSE', reason: 'No longer needed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'closed', closed_at: expect.any(String) });
    expect(await riskOf(o.tenant)).toEqual({ state: 'closed', reason: 'owner_closed', decided_by: o.user });
    const ev = await closedEvents(o.tenant);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_id: o.user, actor_type: 'user', event_payload: { closed_by: 'owner', note: 'No longer needed', from: 'clear', to: 'closed', reason: 'owner_closed' } });

    expect((await status(o)).body).toEqual({ closable: false, closed: true, closed_at: res.body.closed_at });
    const again = await close(o, { confirm: 'CLOSE' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ state: 'closed', closed_at: res.body.closed_at });
    expect(await closedEvents(o.tenant)).toHaveLength(1);
  });

  it('an account under review or restriction can still be closed by its owner', async () => {
    const o = await account('PERSONAL', { riskState: 'restricted' });
    expect((await close(o, { confirm: 'CLOSE' })).status).toBe(200);
    expect((await riskOf(o.tenant)).state).toBe('closed');
    expect((await closedEvents(o.tenant))[0].event_payload).toMatchObject({ from: 'restricted', closed_by: 'owner' });
  });

  it('a member who is not the owner is refused; nothing changes', async () => {
    const o = await account('PERSONAL');
    const other = { tenant: o.tenant, user: await member(o.tenant, 'sign_sender') };
    expect((await status(other)).body).toEqual({ closable: false, closed: false, closed_at: null });
    const res = await close(other, { confirm: 'CLOSE' });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('not_account_owner');
    expect((await riskOf(o.tenant)).state).toBe('clear');
    expect(await closedEvents(o.tenant)).toHaveLength(0);
  });

  it('a Business owner is refused (closed through the organization); a Personal account with no risk state cannot be closed here', async () => {
    const b = await account('BUSINESS');
    expect((await status(b)).body).toEqual({ closable: false, closed: false, closed_at: null });
    const res = await close(b, { confirm: 'CLOSE' });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('business_account_close_via_organization');

    const p = await account('PERSONAL', { riskState: null });
    expect((await status(p)).body).toEqual({ closable: false, closed: false, closed_at: null });
    const nf = await close(p, { confirm: 'CLOSE' });
    expect(nf.status).toBe(404);
    expect(nf.body.error.details.reason).toBe('personal_account_not_closable');
  });
});
