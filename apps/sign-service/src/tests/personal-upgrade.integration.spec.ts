import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { FreePersonalSubscriptionService, LEGAL_DOCUMENTS, type LegalDocumentVersion } from '@aramo/subscription';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { PersonalUpgradeService } from '../app/account/personal-upgrade.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — the Personal → Business
// upgrade (v1/sign/account/upgrade) on real Postgres 17 with the real AppModule, every
// module's real migrations and real RS256 sign-consumer tokens:
//   - dark: 404 while SIGN_PERSONAL_UPGRADE_ENABLED is not 1;
//   - with the shipped registry (Business terms DRAFT) the upgrade is refused
//     (business_terms_not_available) and nothing changes;
//   - with approved terms the owner upgrades IN PLACE: same tenant id, kind BUSINESS,
//     organization name + profile, US region lock, one attestation, tenant_admin added,
//     authorization version bumped, ONE identity.tenant.upgraded_to_business event, the
//     Business terms acceptance, the FREE subscription ended, the retention setting kept;
//   - a repeat, a non-owner and a Business account are refused with stable reasons.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-upgrade-test';
const OWNER_SCOPES = [...ESIGN_ROLE_PERMISSIONS.sign_admin, ESIGN_SCOPE.BILLING_MANAGE];
const APPROVED_TERMS: LegalDocumentVersion = {
  key: 'sign.terms_of_service',
  version: '9.9-test',
  status: 'APPROVED',
  path: 'doc/legal/aramo-sign/terms-of-service.md',
  sha256: 'b'.repeat(64),
  url: 'https://sign.aramo.ai/legal/terms/9.9-test',
  effective_from: '2026-10-01T00:00:00Z',
};
const BODY = {
  confirm: 'UPGRADE',
  organization_name: 'Pat Lee Consulting',
  accept_terms: true,
  organization: {
    legal_name: 'Pat Lee Consulting LLC',
    address_line1: '1 Main St',
    city: 'Vienna',
    state_province: 'VA',
    postal_code: '22181',
    primary_contact_email: 'billing@patlee.example',
    primary_contact_name: 'Pat Lee',
    signer_title: 'Owner',
    authority_attested: true,
  },
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — v1/sign/account/upgrade (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};

  const jwt = (sub: string, tenant_id: string, authz_version = 1): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: 'sign', tenant_id, authz_version })
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
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,'Pat Lee',$3, now())`, [user, `u-${user.slice(0, 8)}@gmail.com`, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, user, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, role]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, user]);
    return user;
  }

  async function account(kind: 'PERSONAL' | 'BUSINESS'): Promise<{ tenant: string; user: string }> {
    const tenant = randomUUID();
    const slug = `u-${tenant.slice(0, 8)}`;
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',true, now())`, [tenant, `Pat Lee (Personal ${slug})`, slug, kind]);
    for (const c of ['core', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [tenant, c]);
    }
    if (kind === 'PERSONAL') await db.query(`INSERT INTO identity."TenantRiskState" (tenant_id, state) VALUES ($1, 'clear')`, [tenant]);
    return { tenant, user: await member(tenant, 'tenant_owner') };
  }

  const setTerms = (registry: readonly LegalDocumentVersion[]) => {
    (module.get(PersonalUpgradeService) as unknown as { legal: readonly LegalDocumentVersion[] }).legal = registry;
  };
  const openFree = (tenant: string) =>
    module.get(FreePersonalSubscriptionService).ensure({ tenant_id: tenant, product_key: 'sign', tenant_kind: 'PERSONAL', tenant_status: 'ACTIVE', mode: 'invite' });

  const http = () => request(app.getHttpServer());
  const status = async (o: { tenant: string; user: string }, v = 1) => http().get('/v1/sign/account/upgrade').set('Authorization', `Bearer ${await jwt(o.user, o.tenant, v)}`);
  const upgrade = async (o: { tenant: string; user: string }, body: unknown, v = 1) =>
    http().post('/v1/sign/account/upgrade').set('Authorization', `Bearer ${await jwt(o.user, o.tenant, v)}`).send(body as object);
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0];
  const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const role of ['tenant_owner', 'tenant_admin', 'sign_sender']) {
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
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'SIGN_PERSONAL_UPGRADE_ENABLED']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    delete process.env['REDIS_URL'];
    delete process.env['SIGN_PERSONAL_UPGRADE_ENABLED'];

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

  it('is dark: 404 on both routes while SIGN_PERSONAL_UPGRADE_ENABLED is not 1; no session → 401', async () => {
    const o = await account('PERSONAL');
    expect((await status(o)).status).toBe(404);
    expect((await upgrade(o, BODY)).status).toBe(404);
    expect((await one(`SELECT kind FROM identity."Tenant" WHERE id = $1`, [o.tenant])).kind).toBe('PERSONAL');
    process.env['SIGN_PERSONAL_UPGRADE_ENABLED'] = '1';
    expect((await http().get('/v1/sign/account/upgrade')).status).toBe(401);
  });

  it('with the shipped registry (Business terms DRAFT) the upgrade is refused and nothing changes', async () => {
    process.env['SIGN_PERSONAL_UPGRADE_ENABLED'] = '1';
    setTerms(LEGAL_DOCUMENTS);
    const o = await account('PERSONAL');
    await openFree(o.tenant);
    const s = await status(o);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ eligible: false, reason: 'business_terms_not_available', terms: null, subscription: { plan_key: 'aramo-sign-free-personal-v1', source: 'FREE' } });
    const r = await upgrade(o, BODY);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('business_terms_not_available');
    expect((await one(`SELECT kind FROM identity."Tenant" WHERE id = $1`, [o.tenant])).kind).toBe('PERSONAL');
    expect(await count(`SELECT count(*) AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [o.tenant])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM subscription."LegalAcceptance" WHERE tenant_id = $1`, [o.tenant])).toBe(0);
  });

  it('the owner upgrades IN PLACE: same tenant, Business kind, profile, roles, terms, FREE plan ended, retention kept, audited once', async () => {
    process.env['SIGN_PERSONAL_UPGRADE_ENABLED'] = '1';
    setTerms([...LEGAL_DOCUMENTS, APPROVED_TERMS]);
    const o = await account('PERSONAL');
    await openFree(o.tenant);
    await db.query(`INSERT INTO sign."SignTenantRetentionPolicy" (tenant_id, retention_days, updated_by) VALUES ($1, 365, $2)`, [o.tenant, o.user]);

    const s = await status(o);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ eligible: true, reason: null, terms: { key: 'sign.terms_of_service', version: '9.9-test' } });

    expect((await upgrade(o, { ...BODY, confirm: 'upgrade' })).body.error.details.reason).toBe('upgrade_confirmation_required');
    const r = await upgrade(o, BODY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'upgraded', kind: 'BUSINESS', organization_name: 'Pat Lee Consulting' });

    const t = await one(`SELECT id, kind, name, legal_name, state_province, country_code, allowed_domain FROM identity."Tenant" WHERE id = $1`, [o.tenant]);
    expect(t).toEqual({ id: o.tenant, kind: 'BUSINESS', name: 'Pat Lee Consulting', legal_name: 'Pat Lee Consulting LLC', state_province: 'VA', country_code: 'US', allowed_domain: null });
    expect((await one(`SELECT region FROM identity."TenantBillingRegionPolicy" WHERE tenant_id = $1`, [o.tenant])).region).toBe('US');
    expect(await count(`SELECT count(*) AS n FROM identity."OrganizationAuthorityAttestation" WHERE tenant_id = $1 AND signer_title = 'Owner'`, [o.tenant])).toBe(1);
    const roles = (
      await db.query(
        `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE m.tenant_id = $1 AND m.user_id = $2 ORDER BY r.key`,
        [o.tenant, o.user],
      )
    ).rows.map((x: { key: string }) => x.key);
    expect(roles).toEqual(['tenant_admin', 'tenant_owner']);
    expect((await one(`SELECT version FROM identity."AuthorizationVersion" WHERE tenant_id = $1 AND principal_id = $2`, [o.tenant, o.user])).version).toBe(2);
    const events = (await db.query(`SELECT actor_id, event_payload FROM identity."IdentityAuditEvent" WHERE tenant_id = $1 AND event_type = 'identity.tenant.upgraded_to_business'`, [o.tenant])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe(o.user);
    expect(events[0].event_payload).toMatchObject({ from_kind: 'PERSONAL', to_kind: 'BUSINESS', organization_name: 'Pat Lee Consulting', ended_subscription_plan_key: 'aramo-sign-free-personal-v1', terms_ref: `sign.terms_of_service@9.9-test#${'b'.repeat(64)}` });
    expect(await count(`SELECT count(*) AS n FROM subscription."LegalAcceptance" WHERE tenant_id = $1 AND user_id = $2 AND document_key = 'sign.terms_of_service' AND version = '9.9-test' AND context = 'IN_APP'`, [o.tenant, o.user])).toBe(1);
    const sub = await one(`SELECT status, ended_at FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [o.tenant]);
    expect(sub.status).toBe('CANCELED');
    expect(sub.ended_at).not.toBeNull();
    expect(await count(`SELECT count(*) AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [o.tenant])).toBe(0);
    expect((await one(`SELECT retention_days FROM sign."SignTenantRetentionPolicy" WHERE tenant_id = $1`, [o.tenant])).retention_days).toBe(365);

    // A repeat is refused (already Business) and writes nothing more.
    const again = await upgrade(o, BODY, 2);
    expect(again.status).toBe(403);
    expect(again.body.error.details.reason).toBe('not_personal_account');
    expect(await count(`SELECT count(*) AS n FROM identity."IdentityAuditEvent" WHERE tenant_id = $1 AND event_type = 'identity.tenant.upgraded_to_business'`, [o.tenant])).toBe(1);
    expect((await status(o, 2)).body).toMatchObject({ eligible: false, reason: 'not_personal_account' });
  });

  it('a member who is not the owner and a Business account are refused', async () => {
    process.env['SIGN_PERSONAL_UPGRADE_ENABLED'] = '1';
    setTerms([...LEGAL_DOCUMENTS, APPROVED_TERMS]);
    const p = await account('PERSONAL');
    const sender = { tenant: p.tenant, user: await member(p.tenant, 'sign_sender') };
    const r1 = await upgrade(sender, BODY);
    expect([r1.status, r1.body.error?.details?.reason]).toEqual([403, 'not_account_owner']);
    const b = await account('BUSINESS');
    const r2 = await upgrade(b, BODY);
    expect([r2.status, r2.body.error?.details?.reason]).toEqual([403, 'not_personal_account']);
    expect((await one(`SELECT kind FROM identity."Tenant" WHERE id = $1`, [p.tenant])).kind).toBe('PERSONAL');
  });
});
