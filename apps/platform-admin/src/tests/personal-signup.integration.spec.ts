import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';
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
import { AuthModule, EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  GEO_IP_PORT,
  IdentityCoreModule,
  LogSmsAdapter,
  DisabledSmsAdapter,
  PersonalRiskService,
  PrismaService as IdentityPrismaService,
  ROBOT_CHECK_PORT,
  SMS_VERIFICATION_PORT,
  type SmsVerificationPort,
} from '@aramo/identity';
import { MAILER_PORT } from '@aramo/mailer';
import { AbuseReportService } from '@aramo/sign';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalAcceptanceService,
  SubscriptionPrismaService,
  type LegalDocumentVersion,
} from '@aramo/subscription';

import { PersonalLapseSweeper } from '../app/platform/personal-lapse-sweeper.service.js';
import { PersonalSignupAttemptPurgeSweeper } from '../app/platform/personal-signup-attempt-purge-sweeper.service.js';
import { PlatformPersonalController } from '../app/platform/platform-personal.controller.js';
import { PersonalSignupController } from '../app/signup/personal-signup.controller.js';
import { PERSONAL_LEGAL_KEYS, PersonalSignupService } from '../app/signup/personal-signup.service.js';
import { SignSignupController } from '../app/signup/sign-signup.controller.js';
import { SignSignupService, SignupBudget } from '../app/signup/sign-signup.service.js';
import { AddressSuggestService } from '../app/signup/address-suggest.service.js';

import { ConfigurableAuthzResolver } from './support/configurable-authz-resolver.js';
import { generateTestKeyPair } from './test-keys.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) — the PUBLIC Personal
// (Free) signup + operator surface on REAL Postgres 17 (stubbed GeoIP / robot
// check / SMS, capturing mailer, no Cognito anywhere): dark when off; the §2
// classification; §6.6 location checks (phone region + residence hard; the
// GeoLite2 network country a risk signal only — Architect ruling 2026-10-21, with
// its evidence stored); §6.2 refusals stored; OTP lifecycle;
// binding preconditions (owner email == OTP-verified email, PROVISIONED tenant,
// tenant_owner ONLY, no ExternalIdentity, no subscription, Google pre-pin);
// legal-not-approved refusal; invite mode / cap / expiry; held accounts; operator
// review actions (clear-review never sets phone assurance; while SMS is
// unavailable it lifts the phone step — PO "Review replaces phone"); the unbound lapse.

const ROOT = resolve(__dirname, '../../../..');
const IDENTITY_MIGRATIONS = resolveIdentityMigrations(ROOT);
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
].map((p) => resolve(ROOT, p));

const TENANT_OWNER_ROLE_ID = '01900000-0000-7000-8000-000000000014';
const TENANT_ADMIN_ROLE_ID = '01900000-0000-7000-8000-0000000002b0';

// Test-only APPROVED versions (independent of the real registry's contents).
const APPROVED: LegalDocumentVersion[] = PERSONAL_LEGAL_KEYS.map((key, i) => ({
  key: key as LegalDocumentVersion['key'],
  version: '1.0.0',
  status: 'APPROVED',
  path: `test/${key}.md`,
  sha256: String(i + 1).repeat(64),
  url: `https://aramo.ai/legal/${key}/1.0.0`,
  effective_from: '2026-01-01T00:00:00Z',
}));
const registryDocs: LegalDocumentVersion[] = [...LEGAL_DOCUMENTS];
const useRegistry = (docs: readonly LegalDocumentVersion[]) => registryDocs.splice(0, registryDocs.length, ...docs);
const ACCEPT_ALL = APPROVED.map((d) => ({ key: d.key, version: d.version }));

// Stubs for the three ports (mutable per test).
const DB_VERSION = 'GeoLite2-Country 2026-10-20T00:00:00.000Z';
const geo = { country: 'US' as string | null, network: 'residential' as const, db_version: DB_VERSION as string | null, throws: false };
const geoStub = {
  countryOf: async () => geo.country,
  networkKind: async () => geo.network,
  lookup: async (_ip: string, now: Date = new Date()) => {
    if (geo.throws) throw new Error('mmdb exploded');
    return { country: geo.country, network_kind: geo.network, looked_up_at: now.toISOString(), db_version: geo.db_version };
  },
};
const robotStub = { verdict: 'pass' as 'pass' | 'low' | 'fail' | 'unavailable', verify: async () => ({ verdict: robotStub.verdict }) };
const logSms = new LogSmsAdapter();
let smsImpl: SmsVerificationPort = new DisabledSmsAdapter();
const smsStub: SmsVerificationPort = {
  get configured() {
    return smsImpl.configured;
  },
  send: (to: string, text: string) => smsImpl.send(to, text),
};

const authz = new ConfigurableAuthzResolver();

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('platform-admin — Sign Personal (Free) signup + operator (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let app: INestApplication;
  let db: IdentityPrismaService;
  let sql: import('pg').Client;
  let privatePem: string;
  const saved = { ...process.env };
  const mail: { to: string; subject: string; html: string; text?: string }[] = [];
  const OPERATOR = uuidv7();

  // The sign schema is not loaded here: libs/sign covers AbuseReportService against
  // Postgres; this spec pins the operator routes' guard, mapping and refusals.
  const REPORT = {
    id: uuidv7(),
    envelope_id: uuidv7(),
    signer_id: uuidv7(),
    reason: 'phishing',
    note: 'asked for a bank login',
    reporter_domain: 'gmail.com',
    severity: 1,
    independence: 1,
    credibility: 1,
    weight: 1,
    triggered_restriction: false,
    outcome: 'OPEN',
    outcome_reason: null,
    decided_by: null,
    decided_at: null,
    created_at: new Date('2026-10-21T00:00:00Z'),
  };
  const queueTenant = { id: '' };
  const reportsStub = {
    listForTenant: vi.fn(async () => [REPORT]),
    listQueue: vi.fn(async () => [{ ...REPORT, tenant_id: queueTenant.id }, { ...REPORT, id: uuidv7(), tenant_id: uuidv7() }]),
    decide: vi.fn(async (a: { report_id: string; outcome: string; reason: string }) =>
      a.report_id === REPORT.id ? { ...REPORT, outcome: a.outcome, outcome_reason: a.reason, decided_at: new Date('2026-10-21T01:00:00Z') } : null,
    ),
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
        { id: TENANT_OWNER_ROLE_ID, key: 'tenant_owner', description: 'Tenant Owner', is_active: true },
        { id: TENANT_ADMIN_ROLE_ID, key: 'tenant_admin', description: 'Tenant Admin', is_active: true },
      ],
    });
    await setup.$disconnect();
    const { Client } = await import('pg');
    sql = new Client({ connectionString: url });
    await sql.connect();
    for (const m of SUBSCRIPTION_MIGRATIONS) await sql.query(readFileSync(m, 'utf8'));

    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    Object.assign(process.env, {
      DATABASE_URL: url,
      AUTH_AUDIENCE: 'aramo-personal-test',
      AUTH_PUBLIC_KEY: keys.publicPem,
      SIGN_SENDER_WEB_BASE_URL: 'https://sign.example.test',
      SIGN_PERSONAL_SIGNUP_MODE: 'open',
      // Every request in this spec comes from one loopback IP: lift the per-IP
      // signal thresholds (they are unit-covered) so they do not leak across tests.
      SIGN_PERSONAL_RISK_CONFIG: JSON.stringify({ ip_signups_points_over: 1000, ip_signups_refuse_over: 1000 }),
    });
    db = new IdentityPrismaService(url);
    await db.$connect();

    module = await Test.createTestingModule({
      imports: [CommonModule, AuthModule, AuthorizationModule, IdentityCoreModule, EntitlementModule],
      controllers: [PersonalSignupController, PlatformPersonalController, SignSignupController],
      providers: [
        PersonalSignupService,
        SignSignupService,
        AddressSuggestService,
        SignupBudget,
        PersonalLapseSweeper,
        PersonalSignupAttemptPurgeSweeper,
        LegalAcceptanceService,
        SubscriptionPrismaService,
        { provide: LEGAL_DOCUMENT_REGISTRY, useValue: registryDocs },
        { provide: MAILER_PORT, useValue: { send: async (m: { to: string; subject: string; html: string }) => (mail.push(m), { message_id: 'm' }) } },
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: authz },
        { provide: AbuseReportService, useValue: reportsStub },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
      ],
    })
      .overrideProvider(GEO_IP_PORT)
      .useValue(geoStub)
      .overrideProvider(ROBOT_CHECK_PORT)
      .useValue(robotStub)
      .overrideProvider(SMS_VERIFICATION_PORT)
      .useValue(smsStub)
      .compile();
    app = module.createNestApplication();
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    await sql?.end();
    await container?.stop();
    process.env = saved;
  }, 60_000);

  beforeEach(() => {
    useRegistry(APPROVED);
    module.get(SignupBudget).reset();
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'open';
    delete process.env['SIGN_PERSONAL_PILOT_CAP'];
    geo.country = 'US';
    geo.db_version = DB_VERSION;
    geo.throws = false;
    robotStub.verdict = 'pass';
    smsImpl = new DisabledSmsAdapter();
  });

  const http = () => request(app.getHttpServer());
  let n = 0;
  const person = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      name: `Pat Person`,
      email: `pat.person.${n}@gmail.com`,
      phone: `+1202555${String(100 + n).padStart(4, '0')}`,
      residence: 'US',
      robot_token: 'tok',
      elapsed_ms: 20_000,
      ...over,
    };
  };
  const codeFrom = (to: string) => {
    const m = [...mail].reverse().find((x) => x.to === to && /verification code/.test(x.subject));
    const c = m?.subject.match(/(\d{6})/)?.[1];
    if (c === undefined) throw new Error(`no code mailed to ${to}`);
    return c;
  };
  const start = (body: Record<string, unknown>) => http().post('/v1/signup/sign/personal/start').send(body);
  async function startedAndVerified(over: Record<string, unknown> = {}) {
    const p = person(over);
    const s = await start(p);
    expect(s.status).toBe(202);
    const v = await http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: s.body.signup_id, code: codeFrom(p.email as string) });
    expect(v.status).toBe(200);
    return { ...p, signup_id: s.body.signup_id as string, next: v.body.next as string };
  }
  const complete = (signup_id: string, accept: unknown = ACCEPT_ALL) => http().post('/v1/signup/sign/personal/complete').send({ signup_id, accept });

  async function jwt(scopes: string[], consumer_type = 'platform'): Promise<string> {
    const key = await importPKCS8(privatePem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type, actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: authz.grant(PLATFORM_TENANT_SENTINEL_ID, OPERATOR, scopes) })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience('aramo-personal-test')
      .setSubject(OPERATOR)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  }
  const op = async () => `Bearer ${await jwt(['platform:tenant:lifecycle:manage'])}`;
  const reason = (r: request.Response) => (r.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

  // ── activation mode ──────────────────────────────────────────────────────────

  it('mode off (the shipped default): every Personal route is 404', async () => {
    for (const v of ['off', '', 'yes']) {
      process.env['SIGN_PERSONAL_SIGNUP_MODE'] = v;
      expect((await http().get('/v1/signup/sign/personal/terms')).status).toBe(404);
      for (const path of ['start', 'resend-email', 'verify-email', 'phone/send', 'phone/verify', 'complete']) {
        expect((await http().post(`/v1/signup/sign/personal/${path}`).send(person())).status).toBe(404);
      }
    }
    delete process.env['SIGN_PERSONAL_SIGNUP_MODE'];
    expect((await http().get('/v1/signup/sign/personal/terms')).status).toBe(404);
  });

  // ── the whole flow + binding preconditions ───────────────────────────────────

  it('allow → email code → terms → complete: PROVISIONED PERSONAL tenant, tenant_owner only, no Cognito / ExternalIdentity / subscription', async () => {
    const p = await startedAndVerified();
    expect(p.next).toBe('terms');
    const terms = await http().get('/v1/signup/sign/personal/terms');
    expect(terms.body.documents.map((d: { key: string }) => d.key)).toEqual([...PERSONAL_LEGAL_KEYS]);
    const done = await complete(p.signup_id);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: 'PROVISIONED', email: p.email, sign_in: { google: expect.stringContaining('idp=google') }, held: null });

    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    expect(row).toMatchObject({ status: 'PROVISIONED', decision: 'allow', accepted_ip: expect.any(String) });
    const tenant = await db.tenant.findUnique({ where: { id: row!.tenant_id! } });
    expect(tenant).toMatchObject({ kind: 'PERSONAL', status: 'PROVISIONED', allowed_domain: null, is_active: true, identity_provider: 'google' });
    expect(await db.tenantDomainClaim.findUnique({ where: { tenant_id: tenant!.id } })).toBeNull();
    const owner = await db.user.findUnique({ where: { id: row!.owner_user_id! } });
    expect(owner?.email).toBe(p.email);
    const membership = await db.userTenantMembership.findFirst({ where: { user_id: owner!.id }, include: { role_assignments: { include: { role: true } } } });
    expect(membership).toMatchObject({ tenant_id: tenant!.id, is_active: true, invite_status: 'ACTIVE' });
    const roles = membership!.role_assignments.map((r) => r.role.key);
    expect(roles).toEqual(['tenant_owner']);
    expect(await db.externalIdentity.count({ where: { user_id: owner!.id } })).toBe(0);
    expect((await sql.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [tenant!.id])).rows[0].n).toBe(0);
    const caps = (await sql.query(`SELECT capability::text FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY 1`, [tenant!.id])).rows.map((r) => r.capability);
    expect(caps).toEqual(['core', 'sign']);
    const acc = (await sql.query(`SELECT document_key, version, context, context_ref FROM subscription."LegalAcceptance" WHERE tenant_id = $1 ORDER BY 1`, [tenant!.id])).rows;
    expect(acc.map((a) => a.document_key)).toEqual([...PERSONAL_LEGAL_KEYS].sort());
    expect(acc.every((a) => a.context === 'SIGNUP' && a.context_ref === p.signup_id)).toBe(true);
    expect(await module.get(PersonalRiskService).riskStateOf(tenant!.id)).toMatchObject({ state: 'clear', step_up_required: false, phone_verified_at: null });
    expect(await db.identityAuditEvent.count({ where: { tenant_id: tenant!.id, event_type: 'identity.personal.signup.provisioned' } })).toBe(1);
    expect(mail.some((m) => m.to === p.email && /ready/.test(m.subject) && m.text?.includes(`Sign in with the Google account for ${p.email}`))).toBe(true);

    // Idempotent: a repeat answers the same and creates nothing.
    expect((await complete(p.signup_id)).body.status).toBe('PROVISIONED');
    expect(await db.tenant.count({ where: { name: tenant!.name } })).toBe(1);
  });

  it('legal documents not approved: terms null and complete refused (nothing provisioned)', async () => {
    // A registry with no APPROVED Personal document (independent of what the real registry holds).
    useRegistry(LEGAL_DOCUMENTS.filter((d) => !(PERSONAL_LEGAL_KEYS as readonly string[]).includes(d.key)));
    const p = await startedAndVerified();
    expect((await http().get('/v1/signup/sign/personal/terms')).body).toEqual({ documents: null });
    const r = await complete(p.signup_id, []);
    expect(r.status).toBe(400);
    expect(reason(r)).toBe('legal_documents_not_approved');
    expect((await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))?.tenant_id).toBeNull();
    // A partly approved set is still "not approved".
    useRegistry([APPROVED[0]!, APPROVED[1]!]);
    expect(reason(await complete(p.signup_id))).toBe('legal_documents_not_approved');
    // Approved, but the person did not accept every exact version.
    useRegistry(APPROVED);
    expect(reason(await complete(p.signup_id, ACCEPT_ALL.slice(1)))).toBe('terms_not_accepted');
    expect(reason(await complete(p.signup_id, [...ACCEPT_ALL.slice(1), { key: ACCEPT_ALL[0]!.key, version: '0.9.0' }]))).toBe('terms_not_accepted');
  });

  // ── §2 classification + §6.6 location ────────────────────────────────────────

  it('business email → Business signup; disposable refused; Business signup still refuses personal', async () => {
    expect(reason(await start(person({ email: 'pat@acme-corp.example' })))).toBe('business_email_use_business_signup');
    expect(reason(await start(person({ email: 'pat@mailinator.com' })))).toBe('personal_email_not_allowed');
    process.env['SIGN_PUBLIC_SIGNUP_ENABLED'] = '1';
    const b = await http().post('/v1/signup/sign/start').send({ email: 'pat@gmail.com', organization_name: 'Pat Co' });
    expect(reason(b)).toBe('business_email_required');
    delete process.env['SIGN_PUBLIC_SIGNUP_ENABLED'];
  });

  it('location: Canadian phone, residence mismatch, residence outside US/IN → refused (hard); India passes', async () => {
    expect(reason(await start(person({ phone: '+14165550123' })))).toBe('personal_location_not_supported');
    expect(reason(await start(person({ residence: 'IN' })))).toBe('personal_location_not_supported');
    expect(reason(await start(person({ residence: 'GB', phone: '+447911123456' })))).toBe('personal_location_not_supported');
    geo.country = 'IN';
    const india = person({ residence: 'IN', phone: `+91987654${String(3000 + n).slice(-4)}` });
    expect((await start(india)).status).toBe(202);
    const row = await db.personalSignupRequest.findFirst({ where: { email: india.email as string } });
    expect(row).toMatchObject({ decision: 'allow', ip_country: 'IN', risk_signals: [] });
  });

  it('network country outside US/IN is a risk signal, not a refusal: 202 → review, with the geo evidence stored', async () => {
    geo.country = 'GB';
    const p = await startedAndVerified();
    expect(p.next).toBe('review');
    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    expect(row).toMatchObject({ decision: 'review', ip_country: 'GB', risk_points: 75 });
    expect(row!.risk_signals).toEqual([
      { key: 'ip_country_outside', points: 60, detail: 'GB' },
      { key: 'phone_ip_country_mismatch', points: 15, detail: 'US/GB' },
    ]);
    expect(row!.geo_evidence).toEqual({ country: 'GB', looked_up_at: expect.any(String), db_version: DB_VERSION });
    expect(new Date((row!.geo_evidence as { looked_up_at: string }).looked_up_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const done = await complete(p.signup_id);
    expect(done.body).toMatchObject({ status: 'PROVISIONED', held: 'review' });
    const t = (await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))!.tenant_id!;
    const prov = await db.identityAuditEvent.findFirst({ where: { tenant_id: t, event_type: 'identity.personal.signup.provisioned' } });
    expect(prov!.event_payload).toMatchObject({ decision: 'review', geo: { country: 'GB', db_version: DB_VERSION } });
    const item = (await http().get('/platform/personal-review').set('Authorization', await op())).body.items.find((i: { tenant_id: string }) => i.tenant_id === t);
    expect(item).toMatchObject({ state: 'review', geo: { country: 'GB', db_version: DB_VERSION }, signals: expect.arrayContaining([expect.objectContaining({ key: 'ip_country_outside' })]) });
  });

  it('a missing GeoLite2 database no longer refuses: signup proceeds with ip_country_unknown (step-up; SMS off → review), evidence country null', async () => {
    geo.country = null;
    geo.db_version = null;
    const p = await startedAndVerified();
    expect(p.next).toBe('review');
    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    expect(row).toMatchObject({ decision: 'step_up', ip_country: null, risk_points: 30, risk_signals: [{ key: 'ip_country_unknown', points: 30 }] });
    expect(row!.geo_evidence).toEqual({ country: null, looked_up_at: expect.any(String), db_version: null });
    // A lookup error is UNKNOWN too — never a 500, never a refusal.
    geo.throws = true;
    const q = person();
    expect((await start(q)).status).toBe(202);
    expect(await db.personalSignupRequest.findFirst({ where: { email: q.email as string } })).toMatchObject({ decision: 'step_up', ip_country: null, geo_evidence: expect.objectContaining({ country: null, db_version: null }) });
  });

  // ── non-enumeration + refusals ───────────────────────────────────────────────

  it('an address with an account: the same 202 + "already have an account" email, nothing stored', async () => {
    const t = uuidv7();
    await db.tenant.create({ data: { id: t, name: `Existing ${t}`, kind: 'PERSONAL' } });
    const email = `existing.${n}@gmail.com`;
    await db.user.create({ data: { id: uuidv7(), email, tenant_id: t } });
    const r = await start(person({ email }));
    expect(r.status).toBe(202);
    expect(r.body.signup_id).toEqual(expect.any(String));
    expect(await db.personalSignupRequest.count({ where: { email } })).toBe(0);
    expect(mail.some((m) => m.to === email && /already have/.test(m.subject))).toBe(true);
    // The decoy id answers like a wrong code.
    expect(reason(await http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: r.body.signup_id, code: '123456' }))).toBe('code_invalid');
  });

  it('honeypot / failed robot check / unavailable robot check → personal_signup_refused; the decision and signals are stored', async () => {
    const hp = person({ hp: 'http://spam' });
    expect(reason(await start(hp))).toBe('personal_signup_refused');
    const row = await db.personalSignupRequest.findFirst({ where: { email: hp.email as string } });
    expect(row).toMatchObject({ status: 'REFUSED', decision: 'refuse' });
    expect(row!.risk_signals).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'honeypot_filled', refuse: true })]));
    robotStub.verdict = 'fail';
    expect(reason(await start(person()))).toBe('personal_signup_refused');
    robotStub.verdict = 'unavailable';
    const u = person();
    expect(reason(await start(u))).toBe('personal_signup_refused');
    expect(await db.personalSignupRequest.count({ where: { email: u.email as string } })).toBe(0);
  });

  // ── OTP lifecycle ────────────────────────────────────────────────────────────

  it('email code: wrong → code_invalid with attempts left; 5 wrong → exhausted; expired → code_expired; resend after 60 s', async () => {
    const p = person();
    const s = await start(p);
    const id = s.body.signup_id as string;
    const verify = (code: string) => http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: id, code });
    const first = await verify('000000');
    expect(reason(first)).toBe('code_invalid');
    expect(first.body.error.details.attempts_remaining).toBe(4);
    for (let i = 0; i < 4; i += 1) await verify('000000');
    expect(reason(await verify(codeFrom(p.email as string)))).toBe('code_attempts_exceeded');

    // Resend: inside 60 s nothing new; after the gap a fresh code (attempts reset).
    const before = mail.length;
    expect((await http().post('/v1/signup/sign/personal/resend-email').send({ signup_id: id })).status).toBe(202);
    expect(mail.length).toBe(before);
    await db.personalSignupRequest.update({ where: { id }, data: { email_otp_last_sent_at: new Date(Date.now() - 61_000) } });
    await http().post('/v1/signup/sign/personal/resend-email').send({ signup_id: id });
    expect(mail.length).toBe(before + 1);
    await db.personalSignupRequest.update({ where: { id }, data: { email_otp_expires_at: new Date(Date.now() - 1000) } });
    expect(reason(await verify(codeFrom(p.email as string)))).toBe('code_expired');
    await db.personalSignupRequest.update({ where: { id }, data: { email_otp_expires_at: new Date(Date.now() + 60_000) } });
    expect((await verify(codeFrom(p.email as string))).body).toEqual({ next: 'terms' });
  });

  // ── step-up / review held accounts (§6.3) ────────────────────────────────────

  it('step-up with SMS disabled: routed to review (next review, held review); clear-review lifts the phone step but never sets phone assurance', async () => {
    const p = await startedAndVerified({ elapsed_ms: 1000 });
    expect(p.next).toBe('review');
    expect((await http().post('/v1/signup/sign/personal/phone/send').send({ signup_id: p.signup_id })).body).toEqual({ sent: false });
    const done = await complete(p.signup_id);
    expect(done.body).toMatchObject({ status: 'PROVISIONED', held: 'review' });
    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    expect(row).toMatchObject({ decision: 'step_up' });
    const risk = module.get(PersonalRiskService);
    expect(await risk.riskStateOf(row!.tenant_id!)).toMatchObject({ state: 'review', step_up_required: true, phone_verified_at: null, reason: 'step_up_phone_unavailable' });

    const auth = await op();
    const queue = await http().get('/platform/personal-review').set('Authorization', auth);
    expect(queue.body.phone_verification_available).toBe(false);
    const item = queue.body.items.find((i: { tenant_id: string }) => i.tenant_id === row!.tenant_id);
    expect(item).toMatchObject({
      owner_email: p.email,
      state: 'review',
      reason: 'step_up_phone_unavailable',
      risk_points: 40,
      signals: [{ key: 'fast_form', points: 40, detail: '1000' }],
      phone_verified_at: null,
      review_clears_phone_step: true,
      step_up_cleared_by: null,
    });

    const cleared = await http().post(`/platform/tenants/${row!.tenant_id}/personal/clear-review`).set('Authorization', auth).send({ reason: 'reviewed' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ state: 'clear', phone_verified_at: null, step_up_required: false, step_up_cleared_by: 'review' });
    const ev = await db.identityAuditEvent.findFirst({ where: { tenant_id: row!.tenant_id!, event_type: 'identity.personal.risk.review_cleared' } });
    expect(ev).toMatchObject({ actor_id: OPERATOR });
    expect(ev!.event_payload).toMatchObject({ step_up_cleared: true, step_up_cleared_by: 'review', phone_verified: false });
    expect(await risk.phoneVerified(row!.tenant_id!)).toBe(false);
    // Young account (< 7 days) in the US sends; only the location rule would hold it.
    expect(await risk.assertPersonalSendAllowed(row!.tenant_id!, { ip_country: 'US', now: new Date() })).toEqual({ ok: true, location: 'inside' });
  });

  it('step-up with SMS configured but the phone never verified: held for the phone; clear-review does NOT lift the phone step', async () => {
    smsImpl = logSms;
    const p = await startedAndVerified({ elapsed_ms: 1000 });
    expect(p.next).toBe('phone');
    const done = await complete(p.signup_id);
    expect(done.body).toMatchObject({ status: 'PROVISIONED', held: 'phone_verification_required' });
    const t = (await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))!.tenant_id!;
    const auth = await op();
    const queue = await http().get('/platform/personal-review').set('Authorization', auth);
    expect(queue.body.phone_verification_available).toBe(true);
    expect(queue.body.items.find((i: { tenant_id: string }) => i.tenant_id === t)).toMatchObject({ reason: 'signup_step_up_unverified', review_clears_phone_step: false });
    const cleared = await http().post(`/platform/tenants/${t}/personal/clear-review`).set('Authorization', auth).send({ reason: 'reviewed' });
    expect(cleared.body).toMatchObject({ state: 'clear', phone_verified_at: null, step_up_required: true, step_up_cleared_by: null });
    expect(await module.get(PersonalRiskService).assertPersonalSendAllowed(t, { ip_country: 'US', now: new Date() })).toEqual({ ok: false, reason: 'phone_verification_required', location: 'inside' });
  });

  it('operator abuse reports: listed per Personal account, decided with a reason; unknown report 404, bad outcome 400', async () => {
    const p = await startedAndVerified({});
    await complete(p.signup_id);
    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    const auth = await op();
    const listed = await http().get(`/platform/tenants/${row!.tenant_id}/personal/reports`).set('Authorization', auth);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ id: REPORT.id, envelope_id: REPORT.envelope_id, reporter_domain: 'gmail.com', weight: 1, outcome: 'OPEN', created_at: '2026-10-21T00:00:00.000Z' }),
    ]);
    expect(listed.body.items[0]).not.toHaveProperty('signer_id');
    expect(reportsStub.listForTenant).toHaveBeenCalledWith(row!.tenant_id);
    const notPersonal = await http().get(`/platform/tenants/${uuidv7()}/personal/reports`).set('Authorization', auth);
    expect(notPersonal.status).toBe(404);

    const bad = await http().post(`/platform/personal-reports/${REPORT.id}/decide`).set('Authorization', auth).send({ outcome: 'OPEN', reason: 'x' });
    expect(bad.status).toBe(400);
    const unknown = await http().post(`/platform/personal-reports/${uuidv7()}/decide`).set('Authorization', auth).send({ outcome: 'DISMISSED', reason: 'duplicate' });
    expect(unknown.status).toBe(404);
    const decided = await http().post(`/platform/personal-reports/${REPORT.id}/decide`).set('Authorization', auth).send({ outcome: 'FALSE_REPORT', reason: 'sender verified' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ id: REPORT.id, outcome: 'FALSE_REPORT', outcome_reason: 'sender verified', decided_at: '2026-10-21T01:00:00.000Z' });
    expect(reportsStub.decide).toHaveBeenLastCalledWith({ report_id: REPORT.id, outcome: 'FALSE_REPORT', actor: expect.any(String), reason: 'sender verified' });

    // M-A7 §5.2 — the queue across every sender names each report's sender kind.
    queueTenant.id = row!.tenant_id!;
    const queue = await http().get('/platform/sign-abuse-reports?outcome=OPEN').set('Authorization', auth);
    expect(queue.status).toBe(200);
    expect(reportsStub.listQueue).toHaveBeenLastCalledWith({ outcome: 'OPEN', limit: 200 });
    expect(queue.body.items[0]).toMatchObject({ id: REPORT.id, tenant_id: row!.tenant_id, sender_kind: 'PERSONAL', outcome: 'OPEN' });
    expect(queue.body.items[0]).not.toHaveProperty('signer_id');
    expect(queue.body.items[1]).toMatchObject({ sender_kind: null, sender_name: null });
    expect((await http().get('/platform/sign-abuse-reports?outcome=MAYBE').set('Authorization', auth)).status).toBe(400);
  });

  it('step-up with SMS (log adapter): phone code verified → next terms → complete not held, phone assurance recorded', async () => {
    smsImpl = logSms;
    const p = await startedAndVerified({ elapsed_ms: 1000 });
    expect((await http().post('/v1/signup/sign/personal/phone/send').send({ signup_id: p.signup_id })).body).toEqual({ sent: true });
    const text = logSms.sent.filter((s) => s.to === p.phone).pop()!.text;
    const code = text.match(/(\d{6})/)![1]!;
    expect(reason(await http().post('/v1/signup/sign/personal/phone/verify').send({ signup_id: p.signup_id, code: code === '000000' ? '111111' : '000000' }))).toBe('code_invalid');
    expect((await http().post('/v1/signup/sign/personal/phone/verify').send({ signup_id: p.signup_id, code })).body).toEqual({ next: 'terms' });
    const done = await complete(p.signup_id);
    expect(done.body.held).toBeNull();
    const row = await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } });
    expect(await module.get(PersonalRiskService).riskStateOf(row!.tenant_id!)).toMatchObject({ state: 'clear', step_up_required: true, phone_verified_at: expect.any(Date) });
  });

  it('review decision proceeds to terms + complete and is held for review', async () => {
    const q = await startedAndVerifiedReview();
    expect(q.next).toBe('review');
    expect((await complete(q.signup_id)).body).toMatchObject({ status: 'PROVISIONED', held: 'review' });
  });

  async function startedAndVerifiedReview() {
    const prev = process.env['SIGN_PERSONAL_RISK_CONFIG'];
    process.env['SIGN_PERSONAL_RISK_CONFIG'] = JSON.stringify({ ip_signups_points_over: 1000, ip_signups_refuse_over: 1000, points: { fast_form: 65 } });
    try {
      return await startedAndVerified({ elapsed_ms: 1000 });
    } finally {
      process.env['SIGN_PERSONAL_RISK_CONFIG'] = prev;
    }
  }

  // ── invite mode + pilot cap ──────────────────────────────────────────────────

  // The cap's tenant term: provisioned by a Personal signup, active, not CLOSED and
  // not closed by the owner / an operator (risk state 'closed').
  const openPersonalTenants = async (): Promise<number> =>
    Number(
      (
        await sql.query(
          `SELECT count(*)::int AS n FROM identity."PersonalSignupRequest" r JOIN identity."Tenant" t ON t.id = r.tenant_id
             LEFT JOIN identity."TenantRiskState" s ON s.tenant_id = t.id
            WHERE r.status = 'PROVISIONED' AND t.is_active AND t.status <> 'CLOSED' AND (s.state IS NULL OR s.state <> 'closed')`,
        )
      ).rows[0].n,
    );

  it('invite mode: code required, bound to the email, single use, 7-day expiry; pilot cap enforced at issue, start and complete', async () => {
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'invite';
    const auth = await op();
    const p = person();
    expect(reason(await start(p))).toBe('invite_required');
    const issued = await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: p.email });
    expect(issued.status).toBe(201);
    expect(issued.body).toEqual({ code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/), email: p.email, expires_at: expect.any(String) });
    expect(reason(await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: 'pat@acme-corp.example' }))).toBe('personal_email_required');
    expect(reason(await start({ ...person(), invite_code: issued.body.code }))).toBe('invite_invalid');

    // An expired invite is refused.
    const old = person();
    const oldInvite = await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: old.email });
    await db.personalSignupInvite.updateMany({ where: { email: old.email as string }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(reason(await start({ ...old, invite_code: oldInvite.body.code }))).toBe('invite_invalid');

    const s = await start({ ...p, invite_code: issued.body.code.toLowerCase() });
    expect(s.status).toBe(202);
    await http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: s.body.signup_id, code: codeFrom(p.email as string) });

    // Pilot full (cap == active count) → complete refused; room → completes and consumes the invite.
    const active = await openPersonalTenants();
    process.env['SIGN_PERSONAL_PILOT_CAP'] = String(active);
    expect(reason(await complete(s.body.signup_id))).toBe('personal_pilot_full');
    expect(reason(await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: person().email }))).toBe('personal_pilot_full');
    process.env['SIGN_PERSONAL_PILOT_CAP'] = String(active + 1);
    expect((await complete(s.body.signup_id)).body.status).toBe('PROVISIONED');
    expect((await db.personalSignupInvite.findFirst({ where: { email: p.email as string } }))?.used_at).not.toBeNull();
    // Now full again for the next person.
    const q = person();
    const qi = await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: q.email });
    expect(reason(qi)).toBe('personal_pilot_full');
  });

  // ── operator actions ─────────────────────────────────────────────────────────

  it('operator: restrict / reinstate / close are audited; a non-personal tenant is 404; tenant tokens are refused', async () => {
    const p = await startedAndVerified();
    await complete(p.signup_id);
    const t = (await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))!.tenant_id!;
    const auth = await op();
    const post = (action: string, body: Record<string, unknown>) => http().post(`/platform/tenants/${t}/personal/${action}`).set('Authorization', auth).send(body);
    expect((await post('restrict', { reason: 'reports confirmed' })).body).toMatchObject({ state: 'restricted', restricted_until: null });
    expect((await post('restrict', { reason: 'x', until: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await post('reinstate', { reason: 'appeal upheld' })).body).toMatchObject({ state: 'clear' });
    expect((await post('reinstate', { reason: 'again' })).status).toBe(400);
    expect((await post('restrict', {})).status).toBe(400);
    expect((await post('close', { reason: 'fraud' })).body).toMatchObject({ state: 'closed' });
    for (const ev of ['restricted', 'reinstated', 'closed']) {
      expect(await db.identityAuditEvent.count({ where: { tenant_id: t, event_type: `identity.personal.risk.${ev}`, actor_id: OPERATOR } })).toBe(1);
    }
    const business = uuidv7();
    await db.tenant.create({ data: { id: business, name: `Biz ${business}` } });
    expect((await http().post(`/platform/tenants/${business}/personal/close`).set('Authorization', auth).send({ reason: 'x' })).status).toBe(404);
    const tenantToken = await jwt(['platform:tenant:lifecycle:manage'], 'recruiter');
    expect((await http().get('/platform/personal-review').set('Authorization', `Bearer ${tenantToken}`)).status).toBe(403);
  });

  it('pilot cap is serialized: two concurrent completes at cap-1 → exactly one provisions', async () => {
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'invite';
    const auth = await op();
    const active = await openPersonalTenants();
    process.env['SIGN_PERSONAL_PILOT_CAP'] = String(active + 1);
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const p = person();
      const inv = await http().post('/platform/personal-invites').set('Authorization', auth).send({ email: p.email });
      expect(inv.status).toBe(201);
      const s = await start({ ...p, invite_code: inv.body.code });
      expect(s.status).toBe(202);
      await http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: s.body.signup_id, code: codeFrom(p.email as string) });
      ids.push(s.body.signup_id);
    }
    const [a, b] = await Promise.all(ids.map((id) => complete(id)));
    const outcomes = [a!, b!].map((r) => (r.status === 200 ? r.body.status : reason(r))).sort();
    expect(outcomes).toEqual(['PROVISIONED', 'personal_pilot_full']);
    const after = await openPersonalTenants();
    expect(after).toBe(active + 1);
  });

  it('a signup that lapsed UNBOUND can sign up again: same tenant + owner re-activated, fresh risk state + acceptances (audited)', async () => {
    const p = await startedAndVerified();
    await complete(p.signup_id);
    const first = (await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))!;
    await module.get(PersonalRiskService).restrict(first.tenant_id!, 'old', null);
    await db.personalSignupRequest.update({ where: { id: first.id }, data: { provisioned_at: new Date(Date.now() - 8 * 24 * 3600_000) } });
    expect(await module.get(PersonalLapseSweeper).tick()).toBeGreaterThanOrEqual(1);
    expect((await db.tenant.findUnique({ where: { id: first.tenant_id! } }))?.is_active).toBe(false);

    // Start again: the normal flow (a real code), not the "already have an account" email.
    const already = mail.filter((m) => m.to === p.email && /already have/.test(m.subject)).length;
    const s = await start({ ...p, signup_id: undefined, next: undefined });
    expect(s.status).toBe(202);
    expect(mail.filter((m) => m.to === p.email && /already have/.test(m.subject)).length).toBe(already);
    const v = await http().post('/v1/signup/sign/personal/verify-email').send({ signup_id: s.body.signup_id, code: codeFrom(p.email as string) });
    expect(v.body).toEqual({ next: 'terms' });
    const done = await complete(s.body.signup_id);
    expect(done.body).toMatchObject({ status: 'PROVISIONED', held: null });

    const second = (await db.personalSignupRequest.findUnique({ where: { id: s.body.signup_id } }))!;
    expect(second.tenant_id).toBe(first.tenant_id);
    expect(second.owner_user_id).toBe(first.owner_user_id);
    expect(await db.user.count({ where: { email: p.email as string } })).toBe(1);
    expect((await db.personalSignupRequest.findUnique({ where: { id: first.id } }))?.status).toBe('LAPSED');
    expect(await db.tenant.findUnique({ where: { id: first.tenant_id! } })).toMatchObject({ is_active: true, status: 'PROVISIONED', kind: 'PERSONAL', identity_provider: 'google' });
    expect(await db.externalIdentity.count({ where: { user_id: first.owner_user_id! } })).toBe(0);
    expect(await module.get(PersonalRiskService).riskStateOf(first.tenant_id!)).toMatchObject({ state: 'clear', restricted_until: null, decided_by: null });
    const acc = (await sql.query(`SELECT count(*)::int AS n FROM subscription."LegalAcceptance" WHERE tenant_id = $1 AND context_ref = $2`, [first.tenant_id, second.id])).rows[0].n;
    expect(acc).toBe(3);
    const ev = await db.identityAuditEvent.findMany({ where: { tenant_id: first.tenant_id!, event_type: 'identity.personal.signup.provisioned' }, orderBy: { created_at: 'asc' } });
    expect(ev).toHaveLength(2);
    expect(ev[1]!.event_payload).toMatchObject({ signup_id: second.id, resumed_from_signup_id: first.id });

    // A bound owner (signed in once) is never resumable: the non-enumerating path.
    await db.externalIdentity.create({ data: { id: uuidv7(), provider: 'cognito', provider_subject: `sub-${uuidv7()}`, user_id: first.owner_user_id! } });
    await db.tenant.update({ where: { id: first.tenant_id! }, data: { is_active: false } });
    await db.personalSignupRequest.update({ where: { id: second.id }, data: { status: 'LAPSED' } });
    const r = await start({ ...person(), email: p.email });
    expect(r.status).toBe(202);
    expect(mail.filter((m) => m.to === p.email && /already have/.test(m.subject)).length).toBe(already + 1);
  });

  // ── signup-attempt cleanup (PO / Lead 2026-10-22) ───────────────────────────

  it('the cleanup sweeper deletes an abandoned attempt 3 days after it expired and a refused one after 180 days; a verified, unexpired attempt stays; re-run is a no-op', async () => {
    const unverified = person();
    const s = await start(unverified);
    expect(s.status).toBe(202);
    const pendingId = s.body.signup_id as string;
    const verified = await startedAndVerified();
    const sweeper = module.get(PersonalSignupAttemptPurgeSweeper);
    const DAY = 24 * 3600_000;
    const expires = (await db.personalSignupRequest.findUnique({ where: { id: pendingId } }))!.expires_at.getTime();
    const globalPurges = () => db.identityAuditEvent.count({ where: { tenant_id: null, event_type: 'identity.personal.signup.attempts_purged' } });
    const before = await globalPurges();

    // Just under 3 days after expiry: kept.
    expect(await sweeper.tick(new Date(expires + 3 * DAY - 60_000))).toBeGreaterThanOrEqual(0);
    expect(await db.personalSignupRequest.findUnique({ where: { id: pendingId } })).not.toBeNull();
    // Push the verified attempt's expiry forward: it is still completable, so never deleted.
    await db.personalSignupRequest.update({ where: { id: verified.signup_id }, data: { expires_at: new Date(expires + 10 * DAY) } });
    // Just over 3 days after expiry: the row (email, phone, address) is gone.
    expect(await sweeper.tick(new Date(expires + 3 * DAY + 60_000))).toBeGreaterThanOrEqual(1);
    expect(await db.personalSignupRequest.findUnique({ where: { id: pendingId } })).toBeNull();
    expect(await db.personalSignupRequest.count({ where: { email: unverified.email as string } })).toBe(0);
    expect((await db.personalSignupRequest.findUnique({ where: { id: verified.signup_id } }))?.status).toBe('EMAIL_VERIFIED');
    expect(await globalPurges()).toBeGreaterThanOrEqual(before + 1);
    const after = await globalPurges();
    expect(await sweeper.tick(new Date(expires + 3 * DAY + 60_000))).toBe(0);
    expect(await globalPurges()).toBe(after);

    // A refused attempt is security evidence: kept at 179 days, deleted at 181.
    const hp = person({ hp: 'http://spam' });
    expect(reason(await start(hp))).toBe('personal_signup_refused');
    const refused = await db.personalSignupRequest.findFirst({ where: { email: hp.email as string, status: 'REFUSED' } });
    expect(refused).not.toBeNull();
    const created = refused!.created_at.getTime();
    expect(await sweeper.tick(new Date(created + 179 * DAY))).toBeGreaterThanOrEqual(0);
    expect(await db.personalSignupRequest.findUnique({ where: { id: refused!.id } })).not.toBeNull();
    expect(await sweeper.tick(new Date(created + 181 * DAY))).toBeGreaterThanOrEqual(1);
    expect(await db.personalSignupRequest.findUnique({ where: { id: refused!.id } })).toBeNull();
  });

  // ── unbound lapse ────────────────────────────────────────────────────────────

  it('the sweeper lapses an unbound PROVISIONED personal signup after 7 days (tenant soft-disabled, audited)', async () => {
    const p = await startedAndVerified();
    await complete(p.signup_id);
    const row = (await db.personalSignupRequest.findUnique({ where: { id: p.signup_id } }))!;
    const sweeper = module.get(PersonalLapseSweeper);
    expect(await sweeper.tick()).toBe(0);
    await db.personalSignupRequest.update({ where: { id: row.id }, data: { provisioned_at: new Date(Date.now() - 8 * 24 * 3600_000) } });
    expect(await sweeper.tick()).toBeGreaterThanOrEqual(1);
    expect((await db.tenant.findUnique({ where: { id: row.tenant_id! } }))?.is_active).toBe(false);
    expect((await db.personalSignupRequest.findUnique({ where: { id: row.id } }))?.status).toBe('LAPSED');
    expect(await db.identityAuditEvent.count({ where: { tenant_id: row.tenant_id!, event_type: 'identity.personal.signup.lapsed' } })).toBe(1);
  });
});
