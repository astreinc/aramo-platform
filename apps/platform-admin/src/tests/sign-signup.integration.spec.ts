import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  AramoExceptionFilter,
  CommonModule,
  RequestIdMiddleware,
  ENTITLEMENT_PROVENANCE_MIGRATION,
  resolveIdentityMigrations,
} from '@aramo/common';
import { AuthModule, EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityCoreModule, PrismaService as IdentityPrismaService } from '@aramo/identity';
import { MAILER_PORT } from '@aramo/mailer';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalAcceptanceService,
  SubscriptionPrismaService,
  type LegalDocumentVersion,
} from '@aramo/subscription';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import { TenantPolicyProvisioningService } from '../app/platform/tenant-policy-provisioning.service.js';
import { AddressSuggestService } from '../app/signup/address-suggest.service.js';
import { SignSignupController } from '../app/signup/sign-signup.controller.js';
import { SIGN_SIGNUP_AUDIT_SOURCE, SignupBudget, SignSignupService } from '../app/signup/sign-signup.service.js';

import { ConfigurableAuthzResolver } from './support/configurable-authz-resolver.js';
import { generateTestKeyPair } from './test-keys.js';

// Aramo Sign launch — self-service BUSINESS signup (provisioning integrity), on
// real Postgres 17 with a mocked Cognito and a capturing mailer: dark by default;
// nothing exists before the emailed link is used; one answer for every start;
// BUSINESS + [core, esign] + tenant_owner + tenant_admin (ROLES-1 PR-2; never a Sign product role); idempotent and
// race-safe completion; rename after a name collision; crash recovery; a newer
// request supersedes the old link.

const IDENTITY_MIGRATIONS = resolveIdentityMigrations(resolve(__dirname, '../../../..'));
const splitDdl = (sql: string) => sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
const ENTITLEMENT_DDL = [
  'CREATE SCHEMA IF NOT EXISTS entitlement',
  `CREATE TYPE entitlement."Capability" AS ENUM ('core', 'ats', 'portal', 'sourcing', 'sign')`,
  `CREATE TABLE IF NOT EXISTS entitlement."TenantEntitlement" (
     tenant_id uuid NOT NULL, capability entitlement."Capability" NOT NULL,
     granted_at timestamptz(6) NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, capability))`,
];
const SUBSCRIPTION_MIGRATIONS = [
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  'libs/subscription/prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  'libs/subscription/prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
  'libs/subscription/prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql',
  'libs/subscription/prisma/migrations/20261020130300_sign_naming_keys/migration.sql',
  // CCP-A5 — the plan-version content projection reads PlanAllowanceWindow (created here).
  'libs/subscription/prisma/migrations/20261023100000_sign_personal_free/migration.sql',
  // CCP-A4 — the product dimension (the subscription Prisma client selects product_key).
  'libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql',
  // CCP-A5 — plan versions + the v1 backfill (the subscription Prisma client selects plan_version_id).
  'libs/subscription/prisma/migrations/20261025160000_ccp_a5_plan_version/migration.sql',
].map((p) => resolve(__dirname, '../../../..', p));
const APPROVED_TERMS: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0' };
// Mutable per test: the registry array the signup service holds.
const registryDocs: LegalDocumentVersion[] = [...LEGAL_DOCUMENTS];
const useRegistry = (docs: readonly LegalDocumentVersion[]) => registryDocs.splice(0, registryDocs.length, ...docs);

// ROLES-1 PR-2 — row 0x2b0 is tenant_admin (formerly org_admin); sign_owner is retired.
const TENANT_ADMIN_ROLE_ID = '01900000-0000-7000-8000-0000000002b0';
const TENANT_OWNER_ROLE_ID = '01900000-0000-7000-8000-000000000014';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('platform-admin — Aramo Sign self-service signup (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let app: INestApplication;
  let db: IdentityPrismaService;
  const saved = { ...process.env };
  const mail: { to: string; subject: string; html: string; text?: string }[] = [];
  const cognito = new Map<string, string>();
  const cognitoMock = {
    adminCreateUser: vi.fn(async (args: { email: string }) => {
      if (cognito.has(args.email)) throw new Error('UsernameExistsException');
      const sub = `cog-${uuidv7()}`;
      cognito.set(args.email, sub);
      return { cognito_sub: sub };
    }),
    adminGetUser: vi.fn(async (args: { email: string }) => (cognito.has(args.email) ? { cognito_sub: cognito.get(args.email) } : null)),
    adminDeleteUser: vi.fn(async (args: { email: string }) => void cognito.delete(args.email)),
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new IdentityPrismaService(url);
    await setup.$connect();
    for (const stmt of [...IDENTITY_MIGRATIONS.flatMap((p) => splitDdl(readFileSync(p, 'utf8'))), ...ENTITLEMENT_DDL, ...splitDdl(readFileSync(resolve(__dirname, '../../../..', ENTITLEMENT_PROVENANCE_MIGRATION), 'utf8'))]) {
      if (stmt.trim().length > 0) await setup.$executeRawUnsafe(stmt.trim());
    }
    await setup.role.createMany({
      data: [
        { id: TENANT_ADMIN_ROLE_ID, key: 'tenant_admin', description: 'Tenant Admin', is_active: true },
        { id: TENANT_OWNER_ROLE_ID, key: 'tenant_owner', description: 'Tenant Owner', is_active: true },
      ],
    });
    await setup.$disconnect();
    const { Client } = await import('pg');
    const sql = new Client({ connectionString: url });
    await sql.connect();
    for (const m of SUBSCRIPTION_MIGRATIONS) await sql.query(readFileSync(m, 'utf8'));
    await sql.end();

    const keys = generateTestKeyPair();
    Object.assign(process.env, {
      DATABASE_URL: url,
      AUTH_AUDIENCE: 'aramo-signup-test',
      AUTH_PUBLIC_KEY: keys.publicPem,
      AUTH_COGNITO_TENANT_USER_POOL_ID: 'test-tenant-pool',
      AUTH_COGNITO_PLATFORM_USER_POOL_ID: 'test-platform-pool',
      SIGN_SENDER_WEB_BASE_URL: 'https://esign.example.test',
      SIGN_PUBLIC_SIGNUP_ENABLED: '1',
    });
    db = new IdentityPrismaService(url);
    await db.$connect();

    module = await Test.createTestingModule({
      imports: [CommonModule, AuthModule, AuthorizationModule, IdentityCoreModule, EntitlementModule],
      controllers: [SignSignupController],
      providers: [
        SignSignupService,
        SignupBudget,
        AddressSuggestService,
        LegalAcceptanceService,
        SubscriptionPrismaService,
        { provide: LEGAL_DOCUMENT_REGISTRY, useValue: registryDocs },
        PlatformInvitationService,
        CognitoAdminService,
        { provide: TenantPolicyProvisioningService, useValue: { publishDefaultLifecyclePackage: vi.fn() } },
        { provide: MAILER_PORT, useValue: { send: async (m: { to: string; subject: string; html: string }) => (mail.push(m), { message_id: 'm' }) } },
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: new ConfigurableAuthzResolver() },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
      ],
    })
      .overrideProvider(CognitoAdminService)
      .useValue(cognitoMock)
      .compile();
    app = module.createNestApplication();
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    await container?.stop();
    process.env = saved;
  }, 60_000);

  beforeEach(() => {
    useRegistry(LEGAL_DOCUMENTS);
    module.get(SignupBudget).reset();
    process.env['SIGN_PUBLIC_SIGNUP_ENABLED'] = '1';
  });

  // Sign Signup Amendment A1 (LOCKED) — the organization details every
  // completion now carries (US; EIN optional and omitted here).
  const ORG = {
    legal_name: 'Acme Holdings LLC',
    address_line1: '500 Congress Ave',
    city: 'Austin',
    state_province: 'TX',
    postal_code: '78701',
    country_code: 'US',
    primary_contact_email: 'billing@acme.test',
    primary_contact_name: 'Pat Owner',
    signer_title: 'Managing Director',
    authority_attested: true,
  } as const;

  let n = 0;
  const company = () => {
    n += 1;
    return { email: `owner${n}@acme${n}.test`, organization_name: `Acme ${n} Ltd`, display_name: `Owner ${n}` };
  };
  const http = () => request(app.getHttpServer());
  const tokenFrom = (to: string) => {
    const m = [...mail].reverse().find((x) => x.to === to);
    const t = m?.html.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    if (t === undefined) throw new Error(`no link mailed to ${to}`);
    return t;
  };
  async function started(c = company()) {
    expect((await http().post('/v1/signup/sign/start').send(c)).status).toBe(202);
    return { ...c, token: tokenFrom(c.email) };
  }

  it('is dark unless SIGN_PUBLIC_SIGNUP_ENABLED=1', async () => {
    process.env['SIGN_PUBLIC_SIGNUP_ENABLED'] = '0';
    for (const path of ['start', 'preview', 'complete']) {
      expect((await http().post(`/v1/signup/sign/${path}`).send(company())).status).toBe(404);
    }
  });

  it('start creates nothing but the request: no tenant, no user, no Cognito account; only the token hash is stored', async () => {
    const before = await db.tenant.count();
    const c = await started();
    expect(await db.tenant.count()).toBe(before);
    expect(await db.user.count({ where: { email: c.email } })).toBe(0);
    expect(cognitoMock.adminCreateUser).not.toHaveBeenCalledWith(expect.objectContaining({ email: c.email }));
    const row = await db.signupRequest.findFirstOrThrow({ where: { email: c.email } });
    expect(row.token_hash).not.toBe(c.token);
    expect(JSON.stringify(row)).not.toContain(c.token);
    expect(mail.find((m) => m.to === c.email)!.html).toContain('https://esign.example.test/signup/verify#token=');
  });

  it('refuses a personal address as a form error; bad input is a 400', async () => {
    const res = await http().post('/v1/signup/sign/start').send({ email: 'someone@gmail.com', organization_name: 'Solo' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('business_email_required');
    expect((await http().post('/v1/signup/sign/start').send({ email: 'x@acme.test' })).status).toBe(400);
  });

  // ROLES-1 PR-2 (§6; Conforming Amendment 5) — the signup owner receives tenant_owner + tenant_admin.
  it('complete provisions a BUSINESS tenant with exactly [core, sign] and a tenant_owner + tenant_admin owner — no Cognito user, no temporary password (federated owner)', async () => {
    const c = await started();
    expect((await http().post('/v1/signup/sign/preview').send({ token: c.token })).body).toEqual({ email: c.email, organization_name: c.organization_name, display_name: c.display_name, status: 'READY' });
    const cognitoCallsBefore = cognitoMock.adminCreateUser.mock.calls.length;
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'PROVISIONED',
      email: c.email,
      organization_name: c.organization_name,
      sign_in_url: 'https://esign.example.test/login',
      sign_in: {
        microsoft: 'https://esign.example.test/auth/sign/login?idp=microsoft&return_to=%2F',
        google: 'https://esign.example.test/auth/sign/login?idp=google&return_to=%2F',
      },
    });
    // Aramo-Sign-Signup-Federated-Owner: no Cognito user, no ExternalIdentity,
    // owner membership ACTIVE (no accept step), tenant enrolled in the enforced
    // provider-pin cohort with no pin yet, and Aramo's own "ready" email.
    expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(cognitoCallsBefore);
    expect(cognito.has(c.email)).toBe(false);

    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(tenant.kind).toBe('BUSINESS');
    const caps = await db.$queryRawUnsafe<{ capability: string }[]>(`SELECT capability::text FROM entitlement."TenantEntitlement" WHERE tenant_id = '${tenant.id}' ORDER BY 1`);
    expect(caps.map((r) => r.capability)).toEqual(['core', 'sign']);
    const user = await db.user.findFirstOrThrow({ where: { email: c.email } });
    const roles = await db.userTenantMembershipRole.findMany({ where: { membership: { user_id: user.id, tenant_id: tenant.id } }, include: { role: true } });
    expect(roles.map((r) => r.role.key).sort()).toEqual(['tenant_admin', 'tenant_owner']);
    expect(await db.externalIdentity.count({ where: { user_id: user.id } })).toBe(0);
    expect((await db.userTenantMembership.findFirstOrThrow({ where: { user_id: user.id } })).invite_status).toBe('ACTIVE');
    expect(await db.tenantIdentityProviderPolicy.findUnique({ where: { tenant_id: tenant.id } })).not.toBeNull();
    expect(tenant.identity_provider).toBeNull();
    const ready = mail.filter((m) => m.to === c.email).at(-1)!;
    expect(ready.subject).toBe('Your Aramo Sign organization is ready');
    expect(ready.html).toContain('idp=microsoft');
    expect(ready.html + (ready.text ?? '')).not.toMatch(/password/i);
    const birth = await db.identityAuditEvent.findFirstOrThrow({ where: { tenant_id: tenant.id, event_type: 'identity.tenant.created' } });
    expect(birth.actor_type).toBe('system');
    expect((birth.event_payload as { source: string }).source).toBe(SIGN_SIGNUP_AUDIT_SOURCE);
    expect(await db.signupRequest.findFirstOrThrow({ where: { email: c.email } })).toMatchObject({ status: 'PROVISIONED', tenant_id: tenant.id, owner_user_id: user.id });
  });

  it('the same link again answers the same and provisions nothing new', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    const calls = cognitoMock.adminCreateUser.mock.calls.length;
    const again = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(again.body.status).toBe('PROVISIONED');
    expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(calls);
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(1);
  });

  it('two concurrent completions provision exactly once', async () => {
    const c = await started();
    const [a, b] = await Promise.all([
      http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG }),
      http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.status, b.body.status].sort()).toEqual(['PROVISIONED', 'PROVISIONING']);
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(1);
  });

  it('every bad link gets the same 404', async () => {
    const msgs = new Set<string>();
    for (const token of ['x'.repeat(43), 'short', '']) {
      const r = await http().post('/v1/signup/sign/complete').send({ token, organization: ORG });
      expect(r.status).toBe(404);
      msgs.add(r.body.error.message);
    }
    const c = await started();
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { expires_at: new Date(Date.now() - 1000) } });
    const expired = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(expired.status).toBe(404);
    msgs.add(expired.body.error.message);
    expect(msgs.size).toBe(1);
  });

  it('an address that already has an account gets a sign-in email, the same 202, and no request', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { created_at: new Date(Date.now() - 120_000) } });
    const res = await http().post('/v1/signup/sign/start').send({ ...c, organization_name: 'Another Org' });
    expect(res.status).toBe(202);
    expect(mail[mail.length - 1]).toMatchObject({ to: c.email, subject: 'You already have an Aramo account' });
    expect(await db.signupRequest.count({ where: { email: c.email } })).toBe(1);
  });

  it('a repeat start inside a minute sends nothing more; a later one supersedes the first link', async () => {
    const c = await started();
    const sent = mail.filter((m) => m.to === c.email).length;
    expect((await http().post('/v1/signup/sign/start').send(c)).status).toBe(202);
    expect(mail.filter((m) => m.to === c.email).length).toBe(sent);
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { created_at: new Date(Date.now() - 120_000) } });
    const second = await started(c);
    expect(second.token).not.toBe(c.token);
    expect((await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG })).status).toBe(404);
    expect((await http().post('/v1/signup/sign/complete').send({ token: second.token, organization: ORG })).body.status).toBe('PROVISIONED');
  });

  it('a taken organization name is a 409 the owner fixes with another name on the same link', async () => {
    const first = await started();
    await http().post('/v1/signup/sign/complete').send({ token: first.token, organization: ORG });
    const c = await started({ ...company(), organization_name: first.organization_name.toUpperCase() });
    const taken = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details.reason).toBe('organization_name_taken');
    expect(cognito.has(c.email)).toBe(false);
    const ok = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization_name: `${c.organization_name} Two`, organization: ORG });
    expect(ok.body).toMatchObject({ status: 'PROVISIONED', organization_name: `${c.organization_name} Two` });
  });

  it('recovers when provisioning finished but the outcome was never recorded', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    // Simulate a crash between the saga and the final write.
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { status: 'FAILED', tenant_id: null, owner_user_id: null } });
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(res.body.status).toBe('PROVISIONED');
    const row = await db.signupRequest.findFirstOrThrow({ where: { email: c.email } });
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(row).toMatchObject({ status: 'PROVISIONED', tenant_id: tenant.id });
  });

  it('the per-IP budget answers start uniformly and complete as an invalid link', async () => {
    for (let i = 0; i < 10; i += 1) await http().post('/v1/signup/sign/start').send(company());
    const c = company();
    expect((await http().post('/v1/signup/sign/start').send(c)).status).toBe(202);
    expect(mail.some((m) => m.to === c.email)).toBe(false);
    expect((await http().post('/v1/signup/sign/complete').send({ token: 'y'.repeat(43), organization: ORG })).status).toBe(404);
  });

  it('terms: none approved ⇒ no terms offered and none recorded', async () => {
    expect((await http().get('/v1/signup/sign/terms')).body).toEqual({ terms: null });
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    const sql = new (await import('pg')).Client({ connectionString: container.getConnectionUri() });
    await sql.connect();
    expect((await sql.query(`SELECT count(*)::int AS n FROM subscription."LegalAcceptance" WHERE subject_email = $1`, [c.email])).rows[0].n).toBe(0);
    await sql.end();
  });

  it('terms: an approved version must be accepted at start and is recorded for the new tenant', async () => {
    useRegistry([...LEGAL_DOCUMENTS, APPROVED_TERMS]);
    expect((await http().get('/v1/signup/sign/terms')).body).toEqual({ terms: { version: '1.0.0', url: APPROVED_TERMS.url } });
    const c = company();
    const refused = await http().post('/v1/signup/sign/start').send(c);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.reason).toBe('terms_not_accepted');
    expect((await http().post('/v1/signup/sign/start').send({ ...c, accept_terms: true })).status).toBe(202);
    const token = tokenFrom(c.email);
    expect((await http().post('/v1/signup/sign/complete').send({ token, organization: ORG })).body.status).toBe('PROVISIONED');
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    const sql = new (await import('pg')).Client({ connectionString: container.getConnectionUri() });
    await sql.connect();
    const rows = await sql.query(`SELECT tenant_id, document_key, version, sha256, context FROM subscription."LegalAcceptance" WHERE subject_email = $1`, [c.email]);
    await sql.end();
    expect(rows.rows).toEqual([{ tenant_id: tenant.id, document_key: 'sign.terms_of_service', version: '1.0.0', sha256: APPROVED_TERMS.sha256, context: 'SIGNUP' }]);
  });

  // ── Sign Signup Amendment A1 (LOCKED) — organization details, US only ──────────

  async function nothingCreated(c: { email: string; organization_name: string }) {
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(0);
    expect(await db.user.count({ where: { email: c.email } })).toBe(0);
    expect((await db.signupRequest.findFirstOrThrow({ where: { email: c.email } })).status).toBe('PENDING');
  }

  it('A1: complete without organization details is a 400 and creates nothing', async () => {
    const c = await started();
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ reason: 'organization_details_invalid', field: 'organization' });
    const missing = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: { ...ORG, city: '' } });
    expect(missing.body.error.details).toMatchObject({ reason: 'organization_details_invalid', field: 'city' });
    await nothingCreated(c);
  });

  it.each([
    ['a non-US country', { country_code: 'IN' }, 'country_code'],
    ['a US territory', { state_province: 'PR' }, 'state_province'],
    ['a military address', { state_province: 'AE' }, 'state_province'],
  ])('A1: %s is refused server-side (organization_country_not_supported) and creates nothing', async (_l, patch, field) => {
    const c = await started();
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: { ...ORG, ...patch } });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ reason: 'organization_country_not_supported', field });
    await nothingCreated(c);
  });

  it('A1: the authority attestation is required', async () => {
    const c = await started();
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: { ...ORG, authority_attested: false } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('authority_attestation_required');
    await nothingCreated(c);
  });

  it('A1: the profile is written with the tenant, the tenant is held to the US, and the attestation identifies the signer and legal entity (not a legal acceptance)', async () => {
    const c = await started();
    const res = await http().post('/v1/signup/sign/complete').send({
      token: c.token,
      organization: { ...ORG, legal_name: 'Acme Profile LLC', tax_id: '123456789', primary_contact_phone: '(512) 555-0147' },
    });
    expect(res.body.status).toBe('PROVISIONED');
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(tenant).toMatchObject({
      legal_name: 'Acme Profile LLC',
      address_line1: '500 Congress Ave',
      address_line2: null,
      city: 'Austin',
      state_province: 'TX',
      postal_code: '78701',
      country_code: 'US',
      primary_contact_email: 'billing@acme.test',
      primary_contact_name: 'Pat Owner',
      primary_contact_phone: '+15125550147',
      tax_id: '12-3456789',
      registration_number: null,
    });
    expect(await db.tenantBillingRegionPolicy.findUnique({ where: { tenant_id: tenant.id } })).toMatchObject({ region: 'US' });
    const request = await db.signupRequest.findFirstOrThrow({ where: { email: c.email } });
    const att = await db.organizationAuthorityAttestation.findMany({ where: { tenant_id: tenant.id } });
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({
      signup_request_id: request.id,
      signer_email: c.email,
      signer_name: 'Pat Owner',
      signer_title: 'Managing Director',
      organization_legal_name: 'Acme Profile LLC',
      statement_version: 'v1',
    });
    expect(att[0]!.statement_sha256).toMatch(/^[0-9a-f]{64}$/);
    // No terms are approved: the attestation is NOT recorded as a legal acceptance.
    const sql = new (await import('pg')).Client({ connectionString: container.getConnectionUri() });
    await sql.connect();
    expect((await sql.query(`SELECT count(*)::int AS n FROM subscription."LegalAcceptance" WHERE tenant_id = $1`, [tenant.id])).rows[0].n).toBe(0);
    await sql.end();
  });

  it('A1: recovery after a crash keeps a single attestation and the US lock', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { status: 'PENDING', tenant_id: null, owner_user_id: null } });
    const again = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(again.body.status).toBe('PROVISIONED');
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(await db.organizationAuthorityAttestation.count({ where: { tenant_id: tenant.id } })).toBe(1);
    expect(await db.tenantBillingRegionPolicy.count({ where: { tenant_id: tenant.id } })).toBe(1);
  });

  // ── Domain-Enforcement P3 (LOCKED) — one organization per email domain ──────

  it('P3 #2 — start on a held domain: the same 202, an "already uses Aramo" email, and no request row', async () => {
    const first = await started();
    expect((await http().post('/v1/signup/sign/complete').send({ token: first.token, organization: ORG })).body.status).toBe('PROVISIONED');
    const domain = first.email.split('@')[1]!;
    const colleague = { email: `colleague@${domain.toUpperCase()}`, organization_name: 'Colleague Org', display_name: 'Colleague' };
    const res = await http().post('/v1/signup/sign/start').send(colleague);
    expect(res.status).toBe(202);
    const last = mail[mail.length - 1]!;
    expect(last).toMatchObject({ to: `colleague@${domain}`, subject: 'Your organization already uses Aramo' });
    expect(last.html).toContain('Ask your organization\u2019s Aramo administrator to invite you.');
    expect(last.html).toContain('https://esign.example.test/login');
    expect(await db.signupRequest.count({ where: { email: `colleague@${domain}` } })).toBe(0);
  });

  it('P3 #2 — complete when the domain became held after start → 409 organization_domain_taken; nothing created', async () => {
    const c = await started();
    const domain = c.email.split('@')[1]!;
    const other = await started({ email: `other@${domain}`, organization_name: 'Other Org Same Domain', display_name: 'Other' });
    expect((await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG })).body.status).toBe('PROVISIONED');
    const cognitoCalls = cognitoMock.adminCreateUser.mock.calls.length;
    const res = await http().post('/v1/signup/sign/complete').send({ token: other.token, organization: ORG });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'TENANT_DOMAIN_UNAVAILABLE',
      message: 'Your organization already uses Aramo. Ask your administrator to invite you.',
      details: { reason: 'organization_domain_taken' },
    });
    expect(await db.tenant.count({ where: { name: 'Other Org Same Domain' } })).toBe(0);
    expect(await db.user.count({ where: { email: `other@${domain}` } })).toBe(0);
    expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(cognitoCalls);
    expect((await db.signupRequest.findFirstOrThrow({ where: { email: `other@${domain}` } })).status).toBe('FAILED');
  });

  it('P3 — the new tenant holds a PROVISIONAL domain claim', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(await db.tenantDomainClaim.findUnique({ where: { tenant_id: tenant.id } })).toMatchObject({
      domain: c.email.split('@')[1],
      claim: 'PROVISIONAL',
      reason: 'provisioned',
    });
  });

  it('P3 #17 — adopt-after-crash still works (adoption runs before the domain check)', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { status: 'PENDING', tenant_id: null, owner_user_id: null } });
    const again = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('PROVISIONED');
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    expect(await db.signupRequest.findFirstOrThrow({ where: { email: c.email } })).toMatchObject({ status: 'PROVISIONED', tenant_id: tenant.id });
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(1);
  });

  it.each([
    ['an inactive (soft-disabled) tenant', { is_active: false }, null],
    ['a tenant whose domain claim lapsed', null, 'LAPSED'],
  ] as const)('P3 #17 — %s is not adopted', async (_l, tenantPatch, claim) => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    if (tenantPatch !== null) await db.tenant.update({ where: { id: tenant.id }, data: tenantPatch });
    if (claim !== null) await db.tenantDomainClaim.update({ where: { tenant_id: tenant.id }, data: { claim } });
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { status: 'PENDING', tenant_id: null, owner_user_id: null } });
    const again = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
    expect(again.status).toBe(409);
    expect(again.body.status).toBeUndefined();
    const row = await db.signupRequest.findFirstOrThrow({ where: { email: c.email } });
    expect(row.status).toBe('FAILED');
    expect(row.tenant_id).toBeNull();
  });

  describe('A1 §2.3 — address search (Geoapify, proxied)', () => {
    let stand: import('node:http').Server;
    let calls: string[] = [];
    beforeAll(async () => {
      const { createServer } = await import('node:http');
      stand = createServer((req, res) => {
        calls.push(req.url ?? '');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            results: [
              { country_code: 'us', state_code: 'TX', housenumber: '500', street: 'Congress Avenue', city: 'Austin', postcode: '78701', formatted: '500 Congress Avenue, Austin, TX 78701, United States of America' },
              { country_code: 'us', state_code: 'PR', housenumber: '1', street: 'Calle Sol', city: 'San Juan', postcode: '00901', formatted: 'San Juan, PR' },
              { country_code: 'ca', state_code: 'ON', housenumber: '1', street: 'King St', city: 'Toronto', postcode: 'M5H', formatted: 'Toronto' },
            ],
          }),
        );
      });
      await new Promise<void>((r) => stand.listen(0, '127.0.0.1', () => r()));
    });
    afterAll(async () => {
      await new Promise<void>((r) => stand.close(() => r()));
      delete process.env['SIGN_ADDRESS_PROVIDER'];
      delete process.env['SIGN_ADDRESS_PROVIDER_KEY'];
      delete process.env['SIGN_ADDRESS_PROVIDER_BASE_URL'];
    });
    beforeEach(() => {
      calls = [];
      module.get(AddressSuggestService).reset();
      const addr = stand.address() as { port: number };
      Object.assign(process.env, {
        SIGN_ADDRESS_PROVIDER: 'geoapify',
        SIGN_ADDRESS_PROVIDER_KEY: 'test-geoapify-key',
        SIGN_ADDRESS_PROVIDER_BASE_URL: `http://127.0.0.1:${addr.port}`,
      });
    });

    it('requires a live signup link (404 otherwise) and is dark with signup off', async () => {
      expect((await http().post('/v1/signup/sign/address/suggest').send({ token: 'z'.repeat(43), text: '500 Congress' })).status).toBe(404);
      const c = await started();
      process.env['SIGN_PUBLIC_SIGNUP_ENABLED'] = '0';
      expect((await http().post('/v1/signup/sign/address/suggest').send({ token: c.token, text: '500 Congress' })).status).toBe(404);
      process.env['SIGN_PUBLIC_SIGNUP_ENABLED'] = '1';
      await http().post('/v1/signup/sign/complete').send({ token: c.token, organization: ORG });
      expect((await http().post('/v1/signup/sign/address/suggest').send({ token: c.token, text: '500 Congress' })).status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it('returns US (50 states + DC) suggestions with the Geoapify attribution; the key never reaches the response', async () => {
      const c = await started();
      const res = await http().post('/v1/signup/sign/address/suggest').send({ token: c.token, text: '500 Congress' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        available: true,
        suggestions: [
          { label: '500 Congress Avenue, Austin, TX 78701, United States of America', address_line1: '500 Congress Avenue', address_line2: null, city: 'Austin', state_province: 'TX', postal_code: '78701' },
        ],
        attribution: { label: 'Powered by Geoapify', url: 'https://www.geoapify.com/' },
      });
      expect(JSON.stringify(res.body)).not.toContain('test-geoapify-key');
      expect(calls[0]).toContain('filter=countrycode%3Aus');
    });

    it('fails open: provider unset or failing → available false', async () => {
      const c = await started();
      delete process.env['SIGN_ADDRESS_PROVIDER'];
      expect((await http().post('/v1/signup/sign/address/suggest').send({ token: c.token, text: '500 Congress' })).body).toEqual({ available: false, suggestions: [], attribution: null });
      process.env['SIGN_ADDRESS_PROVIDER'] = 'geoapify';
      process.env['SIGN_ADDRESS_PROVIDER_BASE_URL'] = 'http://127.0.0.1:9';
      expect((await http().post('/v1/signup/sign/address/suggest').send({ token: c.token, text: '500 Congress' })).body.available).toBe(false);
    });
  });
});

