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
import { TenantDocumentTemplateProvisioningService } from '../app/platform/tenant-document-template-provisioning.service.js';
import { SignSignupController } from '../app/signup/sign-signup.controller.js';
import { SIGN_SIGNUP_AUDIT_SOURCE, SignupBudget, SignSignupService } from '../app/signup/sign-signup.service.js';

import { ConfigurableAuthzResolver } from './support/configurable-authz-resolver.js';
import { generateTestKeyPair } from './test-keys.js';

// Aramo Sign launch — self-service BUSINESS signup (provisioning integrity), on
// real Postgres 17 with a mocked Cognito and a capturing mailer: dark by default;
// nothing exists before the emailed link is used; one answer for every start;
// BUSINESS + [core, esign] + org_admin (never a Sign sender role); idempotent and
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
].map((p) => resolve(__dirname, '../../../..', p));
const APPROVED_TERMS: LegalDocumentVersion = { ...LEGAL_DOCUMENTS[0]!, version: '1.0.0', status: 'APPROVED', url: 'https://aramo.ai/legal/sign/terms/1.0.0' };
// Mutable per test: the registry array the signup service holds.
const registryDocs: LegalDocumentVersion[] = [...LEGAL_DOCUMENTS];
const useRegistry = (docs: readonly LegalDocumentVersion[]) => registryDocs.splice(0, registryDocs.length, ...docs);

const ORG_ADMIN_ROLE_ID = '01900000-0000-7000-8000-0000000002b0';
const ESIGN_OWNER_ROLE_ID = '01900000-0000-7000-8000-0000000002a0';
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
    for (const stmt of [...IDENTITY_MIGRATIONS.flatMap((p) => splitDdl(readFileSync(p, 'utf8'))), ...ENTITLEMENT_DDL]) {
      if (stmt.trim().length > 0) await setup.$executeRawUnsafe(stmt.trim());
    }
    await setup.role.createMany({
      data: [
        { id: ORG_ADMIN_ROLE_ID, key: 'org_admin', description: 'Organization Admin', is_active: true },
        { id: ESIGN_OWNER_ROLE_ID, key: 'sign_owner', description: 'Sign Owner', is_active: true },
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
        LegalAcceptanceService,
        SubscriptionPrismaService,
        { provide: LEGAL_DOCUMENT_REGISTRY, useValue: registryDocs },
        PlatformInvitationService,
        CognitoAdminService,
        { provide: TenantPolicyProvisioningService, useValue: { publishDefaultLifecyclePackage: vi.fn() } },
        { provide: TenantDocumentTemplateProvisioningService, useValue: { publishDefaultRtrTemplate: vi.fn() } },
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

  it('complete provisions a BUSINESS tenant with exactly [core, sign] and an org_admin owner — no Cognito user, no temporary password (federated owner)', async () => {
    const c = await started();
    expect((await http().post('/v1/signup/sign/preview').send({ token: c.token })).body).toEqual({ email: c.email, organization_name: c.organization_name, status: 'READY' });
    const cognitoCallsBefore = cognitoMock.adminCreateUser.mock.calls.length;
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token });
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
    expect(roles.map((r) => r.role.key)).toEqual(['org_admin']);
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
    await http().post('/v1/signup/sign/complete').send({ token: c.token });
    const calls = cognitoMock.adminCreateUser.mock.calls.length;
    const again = await http().post('/v1/signup/sign/complete').send({ token: c.token });
    expect(again.body.status).toBe('PROVISIONED');
    expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(calls);
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(1);
  });

  it('two concurrent completions provision exactly once', async () => {
    const c = await started();
    const [a, b] = await Promise.all([
      http().post('/v1/signup/sign/complete').send({ token: c.token }),
      http().post('/v1/signup/sign/complete').send({ token: c.token }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.status, b.body.status].sort()).toEqual(['PROVISIONED', 'PROVISIONING']);
    expect(await db.tenant.count({ where: { name: c.organization_name } })).toBe(1);
  });

  it('every bad link gets the same 404', async () => {
    const msgs = new Set<string>();
    for (const token of ['x'.repeat(43), 'short', '']) {
      const r = await http().post('/v1/signup/sign/complete').send({ token });
      expect(r.status).toBe(404);
      msgs.add(r.body.error.message);
    }
    const c = await started();
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { expires_at: new Date(Date.now() - 1000) } });
    const expired = await http().post('/v1/signup/sign/complete').send({ token: c.token });
    expect(expired.status).toBe(404);
    msgs.add(expired.body.error.message);
    expect(msgs.size).toBe(1);
  });

  it('an address that already has an account gets a sign-in email, the same 202, and no request', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token });
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
    expect((await http().post('/v1/signup/sign/complete').send({ token: c.token })).status).toBe(404);
    expect((await http().post('/v1/signup/sign/complete').send({ token: second.token })).body.status).toBe('PROVISIONED');
  });

  it('a taken organization name is a 409 the owner fixes with another name on the same link', async () => {
    const first = await started();
    await http().post('/v1/signup/sign/complete').send({ token: first.token });
    const c = await started({ ...company(), organization_name: first.organization_name.toUpperCase() });
    const taken = await http().post('/v1/signup/sign/complete').send({ token: c.token });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details.reason).toBe('organization_name_taken');
    expect(cognito.has(c.email)).toBe(false);
    const ok = await http().post('/v1/signup/sign/complete').send({ token: c.token, organization_name: `${c.organization_name} Two` });
    expect(ok.body).toMatchObject({ status: 'PROVISIONED', organization_name: `${c.organization_name} Two` });
  });

  it('recovers when provisioning finished but the outcome was never recorded', async () => {
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token });
    // Simulate a crash between the saga and the final write.
    await db.signupRequest.updateMany({ where: { email: c.email }, data: { status: 'FAILED', tenant_id: null, owner_user_id: null } });
    const res = await http().post('/v1/signup/sign/complete').send({ token: c.token });
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
    expect((await http().post('/v1/signup/sign/complete').send({ token: 'y'.repeat(43) })).status).toBe(404);
  });

  it('terms: none approved ⇒ no terms offered and none recorded', async () => {
    expect((await http().get('/v1/signup/sign/terms')).body).toEqual({ terms: null });
    const c = await started();
    await http().post('/v1/signup/sign/complete').send({ token: c.token });
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
    expect((await http().post('/v1/signup/sign/complete').send({ token })).body.status).toBe('PROVISIONED');
    const tenant = await db.tenant.findFirstOrThrow({ where: { name: c.organization_name } });
    const sql = new (await import('pg')).Client({ connectionString: container.getConnectionUri() });
    await sql.connect();
    const rows = await sql.query(`SELECT tenant_id, document_key, version, sha256, context FROM subscription."LegalAcceptance" WHERE subject_email = $1`, [c.email]);
    await sql.end();
    expect(rows.rows).toEqual([{ tenant_id: tenant.id, document_key: 'sign.terms_of_service', version: '1.0.0', sha256: APPROVED_TERMS.sha256, context: 'SIGNUP' }]);
  });
});
