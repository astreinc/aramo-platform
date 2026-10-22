import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { GEO_IP_PORT, PersonalRiskService, SMS_VERIFICATION_PORT } from '@aramo/identity';
import { MAILER_PORT } from '@aramo/mailer';
import { AbuseReportService, DOCUMENT_STORAGE_PORT, type DocumentStoragePort, type PutOwnedSourceInput } from '@aramo/sign';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { EsignBillingController } from '../app/billing/esign-billing.controller.js';
import { PersonalLegalStatusService } from '../app/legal/personal-legal-status.service.js';
import { ReportBudget } from '../app/personal/sign-report.service.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §4 / §6 — END TO END on real
// Postgres 17 with the real AppModule and every module's real migrations:
//   mode off      → Personal refused exactly as before; no FREE subscription
//   FREE          → opens only for an ACTIVE PERSONAL tenant; no billing provider
//   allowance     → 2 a day (and 5 a month, subscription spec); one envelope once
//   gate          → review / restricted / step-up without phone / abroad without phone
//   young account → several recipients on a first send, links in the PDF, lure wording
//   reports       → "Report this email" only in Personal signing emails; weighted
//                   reports pause sending for 72 h (lapses unless confirmed); a
//                   FALSE_REPORT lowers that reporter's weight; guest signing unaffected
//   Business      → unchanged (no report link, no daily window, checkout path intact)

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const BASE = 'https://sign.example.test';
const SIGN_SCOPES = ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'sign:billing:manage'];

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — Personal Free (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let envelopes: SenderEnvelopeService;
  let ctx: SenderContextService;
  let billing: EsignBillingController;
  let risk: PersonalRiskService;
  let reports: AbuseReportService;
  const saved: Record<string, string | undefined> = {};
  const owned = new Map<string, Uint8Array>();
  const mails: Mail[] = [];
  // GeoIP stub: the client address (X-Forwarded-For) → country.
  const countries = new Map<string, string>([['198.51.100.1', 'US'], ['198.51.100.2', 'IN'], ['203.0.113.9', 'DE']]);
  const DB_VERSION = 'GeoLite2-Country 2026-10-20T00:00:00.000Z';
  const geoStub = {
    countryOf: async (ip: string) => countries.get(ip) ?? null,
    networkKind: async () => 'residential' as const,
    lookup: async (ip: string, now: Date = new Date()) => ({ country: countries.get(ip) ?? null, network_kind: 'residential' as const, looked_up_at: now.toISOString(), db_version: DB_VERSION }),
  };
  // SMS availability (mutable per test): on = a provider is configured.
  const sms = { on: true };
  const legal: { owed: { key: string; version: string; url: string; title: string }[] } = { owed: [] };
  const legalStub = { pendingFor: vi.fn(async () => legal.owed), pending: vi.fn(async () => legal.owed) };
  const smsStub = {
    get configured() {
      return sms.on;
    },
    send: async () => ({ ok: sms.on, ref: null }),
  };
  const storage: DocumentStoragePort = {
    async putOwnedSource(i: PutOwnedSourceInput) {
      const k = `esign/source/${i.tenant_id}/${i.envelope_id}/${i.object_id ?? randomUUID()}`;
      owned.set(k, new Uint8Array(i.bytes));
      return { source_object_key: k, byte_size: i.bytes.byteLength, source_sha256: createHash('sha256').update(i.bytes).digest('hex') };
    },
    async getOwnedSource(k: string) {
      const b = owned.get(k);
      if (b === undefined) throw new Error('missing');
      return b;
    },
  };

  const auth = (tenant_id: string, sub: string): AuthContextType => ({ sub, consumer_type: 'sign', actor_kind: 'user', tenant_id, scopes: SIGN_SCOPES, iat: 0, exp: 0 });

  async function tenant(kind: 'PERSONAL' | 'BUSINESS', status = 'ACTIVE', createdDaysAgo = 0): Promise<{ id: string; owner: string; a: AuthContextType }> {
    const id = randomUUID();
    const owner = randomUUID();
    const slug = `t-${id.slice(0, 8)}`;
    await db.query(
      `INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,true, now() - ($6 || ' days')::interval, now())`,
      [id, `Tenant ${slug}`, slug, kind, status, String(createdDaysAgo)],
    );
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$3,$4, now())`, [owner, `${slug}@gmail.com`, 'Pat Example', id]);
    for (const c of kind === 'BUSINESS' ? ['core', 'sign', 'ats'] : ['core', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [id, c]);
    }
    return { id, owner, a: auth(id, owner) };
  }

  async function riskState(
    tenant_id: string,
    over: Partial<{ state: string; step_up_required: boolean; phone_verified_at: Date | null; restricted_until: Date | null; created_days_ago: number }> = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO identity."TenantRiskState" (tenant_id, state, step_up_required, phone_e164, phone_verified_at, restricted_until, created_at)
       VALUES ($1, $2, $3, '+14155550100', $4, $5, now() - ($6 || ' days')::interval)
       ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state, step_up_required = EXCLUDED.step_up_required, phone_verified_at = EXCLUDED.phone_verified_at, restricted_until = EXCLUDED.restricted_until, created_at = EXCLUDED.created_at`,
      [tenant_id, over.state ?? 'clear', over.step_up_required ?? false, over.phone_verified_at ?? null, over.restricted_until ?? null, String(over.created_days_ago ?? 0)],
    );
  }

  async function pdf(text = 'Lease agreement'): Promise<string> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    return Buffer.from(await doc.save()).toString('base64');
  }

  async function draft(a: AuthContextType, opts: { subject?: string; recipients?: number; text?: string } = {}): Promise<string> {
    const env = await envelopes.create(a, { subject: opts.subject ?? 'Lease' }, 'r');
    const doc = await envelopes.upload(a, env.id, { filename: 'lease.pdf', content_base64: await pdf(opts.text) }, 'r');
    const n = opts.recipients ?? 1;
    const domains = ['acme-a.test', 'acme-b.test', 'acme-c.test'];
    const d = await envelopes.replaceRecipients(
      a,
      env.id,
      { recipients: Array.from({ length: n }, (_, i) => ({ name: `Signer ${i + 1}`, email: `signer${i + 1}.${env.id.slice(0, 6)}@${domains[i % domains.length]}` })) },
      'r',
    );
    await envelopes.replaceFields(
      a,
      env.id,
      { fields: d.recipients.map((r) => ({ envelope_document_id: doc.id, signer_id: r.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 150, height: 40 })) },
      'r',
    );
    return env.id;
  }

  const send = (a: AuthContextType, id: string, ip = '198.51.100.1') => envelopes.send(a, id, {}, 'r', { ip });
  const http = () => request(app.getHttpServer());
  const tokenFrom = (m: Mail | undefined): string => /\/s\/([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1] ?? '';
  const reportTokenFrom = (m: Mail | undefined): string | null => /\/report#token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1] ?? null;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'ARAMO_SIGN_BASE_URL', 'SIGN_PERSONAL_SIGNUP_MODE']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = 'aramo-sign-personal-test';
    process.env['AUTH_PUBLIC_KEY'] = 'unused';
    process.env['ARAMO_SIGN_BASE_URL'] = BASE;
    delete process.env['REDIS_URL'];
    delete process.env['SIGN_PERSONAL_SIGNUP_MODE'];

    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCUMENT_STORAGE_PORT)
      .useValue(storage)
      .overrideProvider(MAILER_PORT)
      .useValue({
        async send(m: Mail) {
          mails.push(m);
          return { message_id: `m-${mails.length}` };
        },
      })
      .overrideProvider(GEO_IP_PORT)
      .useValue(geoStub)
      .overrideProvider(SMS_VERIFICATION_PORT)
      .useValue(smsStub)
      // Legal re-acceptance is covered by sign-legal.integration.spec; here the
      // sender owes nothing unless a test says so.
      .overrideProvider(PersonalLegalStatusService)
      .useValue(legalStub)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    envelopes = module.get(SenderEnvelopeService);
    ctx = module.get(SenderContextService);
    billing = module.get(EsignBillingController);
    risk = module.get(PersonalRiskService);
    reports = module.get(AbuseReportService);
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
    legal.owed = [];
    module.get(ReportBudget).reset();
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'invite';
    sms.on = true;
  });

  // ── mode off: byte-identical refusal ─────────────────────────────────────────

  it('mode off (unset): Personal authoring, sending and checkout are refused exactly as before; no FREE subscription opens', async () => {
    delete process.env['SIGN_PERSONAL_SIGNUP_MODE'];
    const p = await tenant('PERSONAL');
    await riskState(p.id);
    const refusal = { statusCode: 403, code: 'INSUFFICIENT_PERMISSIONS', message: 'Sending from a personal account is not enabled', context: { details: { reason: 'personal_sending_not_enabled' } } };
    await expect(envelopes.create(p.a, { subject: 'x' }, 'r')).rejects.toMatchObject(refusal);
    await expect(ctx.assertCanAuthor(p.a, 'r')).rejects.toMatchObject(refusal);
    await expect(billing.checkout(p.a, 'r', { plan_key: 'aramo-sign-standard-business-v1' })).rejects.toMatchObject(refusal);
    const view = await ctx.context(p.a, 'r');
    expect(view).toMatchObject({ workspace: 'personal', can_send: false, personal_sending_enabled: false });
    const account = await billing.account(p.a, 'r');
    expect(account).toMatchObject({ subscription: null, allowance: { subscribed: false, state: 'NONE' }, self_service_eligible: false, can_manage_billing: false });
    const n = await db.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [p.id]);
    expect(n.rows[0].n).toBe(0);
    // 'off' spelled out behaves the same.
    process.env['SIGN_PERSONAL_SIGNUP_MODE'] = 'off';
    await expect(envelopes.create(p.a, { subject: 'x' }, 'r')).rejects.toMatchObject(refusal);
  });

  // ── FREE subscription ────────────────────────────────────────────────────────

  it('FREE opens only for an ACTIVE PERSONAL tenant, with no billing linkage; checkout stays refused', async () => {
    const provisioned = await tenant('PERSONAL', 'PROVISIONED');
    await expect(envelopes.create(provisioned.a, { subject: 'x' }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'personal_sending_not_enabled' } } });
    expect((await billing.account(provisioned.a, 'r')).subscription).toBeNull();

    const p = await tenant('PERSONAL');
    const account = await billing.account(p.a, 'r');
    expect(account.subscription).toMatchObject({ plan_key: 'aramo-sign-free-personal-v1', source: 'FREE', status: 'ACTIVE', sending: true, billing_managed: false });
    expect(account.allowance).toMatchObject({ subscribed: true, limit: 5, used: 0, remaining: 5, daily: { window: 'DAY', limit: 2, used: 0, remaining: 2, next_available_at: null } });
    expect(account.storage).toMatchObject({ limit: 15728640 });
    expect(account).toMatchObject({ tenant_kind: 'PERSONAL', self_service_eligible: false, can_manage_billing: false });
    const row = await db.query(`SELECT billing_provider, billing_account_ref, billing_subscription_ref, activated_by FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [p.id]);
    expect(row.rows).toEqual([{ billing_provider: null, billing_account_ref: null, billing_subscription_ref: null, activated_by: null }]);
    await expect(billing.checkout(p.a, 'r', { plan_key: 'aramo-sign-standard-business-v1' })).rejects.toMatchObject({ context: { details: { reason: 'personal_sending_not_enabled' } } });
    expect((await ctx.context(p.a, 'r'))).toMatchObject({ can_send: true, personal_sending_enabled: true });
  });

  // ── the risk gate ─────────────────────────────────────────────────────────────

  it('gate reasons: no state / review / restricted / step-up without phone; IP location alone never refuses as location', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    const id = await draft(p.a);
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } }); // no state → fail closed
    await riskState(p.id, { state: 'review' });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    await riskState(p.id, { state: 'restricted', restricted_until: new Date(Date.now() + 3_600_000) });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'personal_restricted' } } });
    await riskState(p.id, { state: 'clear', step_up_required: true });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    // Young account (risk state < 7 days) sending from outside US/IN → flagged for review.
    await riskState(p.id, { state: 'clear' });
    await expect(send(p.a, id, '203.0.113.9')).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    expect(await risk.riskStateOf(p.id)).toMatchObject({ state: 'review', reason: 'send_location_outside' });
    // Young account from an UNKNOWN location → review too (send_location_unknown).
    await riskState(p.id, { state: 'clear' });
    await expect(send(p.a, id, '192.0.2.77')).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    expect(await risk.riskStateOf(p.id)).toMatchObject({ state: 'review', reason: 'send_location_unknown' });
    // Established account with a step-up outstanding (open risk signal) from abroad → review.
    await riskState(p.id, { state: 'clear', step_up_required: true, created_days_ago: 30 });
    await expect(send(p.a, id, '203.0.113.9')).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    // Nothing was charged by refused sends.
    const used = await db.query(`SELECT count(*)::int AS n FROM subscription."AllowanceUsage" WHERE tenant_id = $1`, [p.id]);
    expect(used.rows[0].n).toBe(0);
    // Established account (no phone assurance, no open signals): abroad and UNKNOWN are ALLOWED and audited.
    await riskState(p.id, { state: 'clear', created_days_ago: 30 });
    await expect(send(p.a, id, '203.0.113.9')).resolves.toMatchObject({ status: 'SENT' });
    await expect(send(p.a, await draft(p.a), '192.0.2.77')).resolves.toMatchObject({ status: 'SENT' });
    const sig = await db.query(
      `SELECT event_payload FROM identity."IdentityAuditEvent" WHERE tenant_id = $1 AND event_type = 'identity.personal.risk.send_location_signal' ORDER BY created_at`,
      [p.id],
    );
    expect(sig.rows.map((r) => r.event_payload)).toEqual([
      expect.objectContaining({ location: 'outside', outcome: 'flagged_for_review', geo: { country: 'DE', looked_up_at: expect.any(String), db_version: DB_VERSION } }),
      expect.objectContaining({ location: 'unknown', outcome: 'flagged_for_review', geo: expect.objectContaining({ country: null, db_version: DB_VERSION }) }),
      expect.objectContaining({ location: 'outside', outcome: 'flagged_for_review' }),
      expect.objectContaining({ location: 'outside', outcome: 'allowed', geo: expect.objectContaining({ country: 'DE' }) }),
      expect.objectContaining({ location: 'unknown', outcome: 'allowed' }),
    ]);
  });

  it('a restricted account may still void; existing envelopes are unaffected', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    await riskState(p.id);
    const id = await draft(p.a);
    await send(p.a, id, '198.51.100.2');
    await riskState(p.id, { state: 'restricted', restricted_until: null });
    await expect(envelopes.remind(p.a, id, {}, 'r', { ip: '198.51.100.1' })).rejects.toMatchObject({ context: { details: { reason: 'personal_restricted' } } });
    await expect(envelopes.void(p.a, id, { reason: 'withdrawn' }, 'r')).resolves.toMatchObject({ status: 'VOIDED' });
  });

  // ── allowance ─────────────────────────────────────────────────────────────────

  it('a sender who owes a legal acceptance is refused legal_acceptance_required before any send check', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    await riskState(p.id);
    const id = await draft(p.a);
    legal.owed = [{ key: 'aramo.privacy_notice', version: '1.0', url: 'https://sign.aramo.ai/legal/privacy/1.0', title: 'Privacy Notice' }];
    await expect(send(p.a, id)).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'legal_acceptance_required' } } });
    expect(legalStub.pendingFor).toHaveBeenLastCalledWith(expect.objectContaining({ id: p.id, kind: 'PERSONAL' }), p.a.sub);
    legal.owed = [];
    await expect(send(p.a, id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('2 a day: the third send in 24 hours is refused DAILY_LIMIT_REACHED; each envelope counts once', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    await riskState(p.id);
    for (let i = 0; i < 2; i += 1) await expect(send(p.a, await draft(p.a))).resolves.toMatchObject({ status: 'SENT' });
    const third = await draft(p.a);
    await expect(send(p.a, third)).rejects.toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED', statusCode: 409, context: { details: { reason: 'DAILY_LIMIT_REACHED', window: 'DAY', limit: 2, used: 2 } } });
    const rows = await db.query(`SELECT state, count(*)::int AS n FROM subscription."AllowanceUsage" WHERE tenant_id = $1 GROUP BY state ORDER BY state`, [p.id]);
    expect(rows.rows).toEqual([{ state: 'CONSUMED', n: 2 }]);
    const account = await billing.account(p.a, 'r');
    expect(account.allowance).toMatchObject({ used: 2, remaining: 3, daily: { used: 2, remaining: 0 } });
  });

  // ── young-account checks ──────────────────────────────────────────────────────

  it('young account: a first send to several recipients asks for phone assurance (step-up)', async () => {
    const p = await tenant('PERSONAL');
    await riskState(p.id);
    const id = await draft(p.a, { recipients: 2 });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    const s = await risk.riskStateOf(p.id);
    expect(s).toMatchObject({ state: 'clear', step_up_required: true, phone_verified_at: null });
    // Phone assurance (only a real phone check sets it) satisfies the step-up.
    await risk.markPhoneVerified(p.id, '+14155550100');
    await expect(send(p.a, id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('young account: a link in the PDF asks for phone assurance', async () => {
    const p = await tenant('PERSONAL');
    await riskState(p.id);
    const id = await draft(p.a, { text: 'Sign here then visit https://pay.example.test/now' });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'phone_verification_required' } } });
    expect((await risk.riskStateOf(p.id))?.step_up_required).toBe(true);
  });

  it('young account, SMS unavailable: a step-up check routes the account to review instead (PO "Review replaces phone")', async () => {
    sms.on = false;
    const p = await tenant('PERSONAL');
    await riskState(p.id);
    const id = await draft(p.a, { recipients: 2 });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    expect(await risk.riskStateOf(p.id)).toMatchObject({ state: 'review', step_up_required: true, reason: 'step_up_phone_unavailable', phone_verified_at: null });
    // An operator clearing that review lifts the phone step, never phone assurance; the send then goes.
    const cleared = await risk.clearReview(p.id, randomUUID(), 'reviewed');
    expect(cleared).toMatchObject({ state: 'clear', step_up_required: false, step_up_cleared_by: 'review', phone_verified_at: null });
    await expect(send(p.a, id)).resolves.toMatchObject({ status: 'SENT' });
  });

  it('young account: lure wording in the title queues the account for review', async () => {
    const p = await tenant('PERSONAL');
    await riskState(p.id);
    const id = await draft(p.a, { subject: 'Verify your account to keep access' });
    await expect(send(p.a, id)).rejects.toMatchObject({ context: { details: { reason: 'personal_review_pending' } } });
    expect((await risk.riskStateOf(p.id))?.state).toBe('review');
  });

  it('an established account (over 30 days and 10 sends) is not subject to the young-account checks', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 90);
    await riskState(p.id);
    // Ten earlier sends on record.
    for (let i = 0; i < 10; i += 1) {
      await db.query(`INSERT INTO sign."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, updated_at) VALUES ($1,$2,'old','COMPLETED','SINGLE_SIGNATURE',$3, now())`, [randomUUID(), p.id, p.owner]);
    }
    const id = await draft(p.a, { subject: 'Verify your account', recipients: 2 });
    await expect(send(p.a, id)).resolves.toMatchObject({ status: 'SENT' });
  });

  // ── reports ───────────────────────────────────────────────────────────────────

  it('Personal signing emails carry "Report this email"; weighted reports pause sending for 72 hours; guest signing is unaffected', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    await riskState(p.id);
    const first = mails.length;
    const id = await draft(p.a, { recipients: 2 });
    await risk.markPhoneVerified(p.id, '+14155550100');
    await send(p.a, id);
    const sent = mails.slice(first).filter((m) => m.subject.startsWith('Please sign'));
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(m.html).toContain('Report this email');
      expect(reportTokenFrom(m)).toBe(tokenFrom(m)); // the recipient's own signing token, in the fragment
    }

    // Validation and link errors.
    expect((await http().post('/v1/sign/report').send({ token: reportTokenFrom(sent[0]), reason: 'nonsense' })).status).toBe(400);
    expect((await http().post('/v1/sign/report').send({ token: 'x'.repeat(43), reason: 'spam' })).status).toBe(404);

    // First report: phishing, severity 3 → below the threshold (4).
    const r1 = await http().post('/v1/sign/report').set('X-Forwarded-For', '198.51.100.50').send({ token: reportTokenFrom(sent[0]), reason: 'phishing', note: 'Asked for my bank login' });
    expect(r1.status).toBe(202);
    expect(r1.body).toEqual({ received: true });
    // One report per recipient per envelope.
    expect((await http().post('/v1/sign/report').send({ token: reportTokenFrom(sent[0]), reason: 'spam' })).status).toBe(409);
    expect((await risk.riskStateOf(p.id))?.state).toBe('clear');

    // Second recipient (different domain), same envelope: 3 × 1/(1+0.5) = 2 → total 5 ≥ 4.
    const before = Date.now();
    expect((await http().post('/v1/sign/report').send({ token: reportTokenFrom(sent[1]), reason: 'impersonation' })).status).toBe(202);
    const s = await risk.riskStateOf(p.id);
    expect(s).toMatchObject({ state: 'restricted', reason: 'abuse_reports' });
    const until = s?.restricted_until?.getTime() ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + 72 * 3_600_000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 72 * 3_600_000 + 5_000);
    const rows = await db.query(`SELECT reason, severity, independence, credibility, weight, triggered_restriction, note FROM sign."AbuseReport" WHERE envelope_id = $1 ORDER BY created_at`, [id]);
    expect(rows.rows).toEqual([
      { reason: 'phishing', severity: 3, independence: 1, credibility: 1, weight: 3, triggered_restriction: false, note: 'Asked for my bank login' },
      { reason: 'impersonation', severity: 3, independence: 0.667, credibility: 1, weight: 2, triggered_restriction: true, note: null },
    ]);
    // Reporter addresses are never stored.
    const raw = await db.query(`SELECT count(*)::int AS n FROM sign."AbuseReport" WHERE reporter_key LIKE '%@%'`);
    expect(raw.rows[0].n).toBe(0);

    // New sends pause…
    await expect(send(p.a, await draft(p.a))).rejects.toMatchObject({ context: { details: { reason: 'personal_restricted' } } });
    // …and the pause lapses by itself after 72 hours unless an operator confirms it.
    expect(await risk.assertPersonalSendAllowed(p.id, { ip_country: 'US', now: new Date(until + 1000) })).toEqual({ ok: true, location: 'inside' });
    expect(await risk.assertPersonalSendAllowed(p.id, { ip_country: 'US', now: new Date(until - 1000) })).toEqual({ ok: false, reason: 'personal_restricted' });

    // Guest signers are never restricted by the sender's state: the signing link still works.
    const ex = await http().post('/v1/sign/signing/exchange').send({ token: tokenFrom(sent[0]) });
    expect(ex.status).toBeLessThan(300);
  });

  it('a report judged FALSE_REPORT lowers that reporter’s later weight and leaves the total', async () => {
    const p = await tenant('PERSONAL', 'ACTIVE', 60);
    await riskState(p.id, { phone_verified_at: new Date() });
    const first = mails.length;
    const e1 = await draft(p.a);
    await send(p.a, e1);
    const m1 = mails.slice(first).find((m) => m.subject.startsWith('Please sign'));
    expect((await http().post('/v1/sign/report').send({ token: reportTokenFrom(m1), reason: 'spam' })).status).toBe(202);
    const [rep] = await reports.listForTenant(p.id);
    expect(rep).toMatchObject({ weight: 1.5, outcome: 'OPEN' });
    await reports.decide({ report_id: rep!.id, outcome: 'FALSE_REPORT', actor: 'operator-1', reason: 'legitimate lease' });
    expect(await reports.tenantTotal(p.id)).toBe(0);

    // The same recipient address on a later envelope: credibility halves.
    const email = (await db.query(`SELECT email FROM sign."Signer" WHERE envelope_id = $1`, [e1])).rows[0].email as string;
    const e2 = await envelopes.create(p.a, { subject: 'Second' }, 'r');
    const doc = await envelopes.upload(p.a, e2.id, { filename: 'b.pdf', content_base64: await pdf() }, 'r');
    const d = await envelopes.replaceRecipients(p.a, e2.id, { recipients: [{ name: 'Same', email }] }, 'r');
    await envelopes.replaceFields(p.a, e2.id, { fields: [{ envelope_document_id: doc.id, signer_id: d.recipients[0]!.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 150, height: 40 }] }, 'r');
    const before = mails.length;
    await send(p.a, e2.id);
    const m2 = mails.slice(before).find((m) => m.subject.startsWith('Please sign'));
    expect((await http().post('/v1/sign/report').send({ token: reportTokenFrom(m2), reason: 'spam' })).status).toBe(202);
    const latest = (await reports.listForTenant(p.id)).find((r) => r.envelope_id === e2.id);
    expect(latest).toMatchObject({ credibility: 0.5, weight: 0.75 });
  });

  // ── Business regression ───────────────────────────────────────────────────────

  it('Business: sends as before — no report link, no day window, no Personal checks, reports not taken', async () => {
    const b = await tenant('BUSINESS');
    await db.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by) SELECT gen_random_uuid(), $1::uuid, p.id, now(), 'MANUAL', 'test' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
      [b.id],
    );
    const first = mails.length;
    for (let i = 0; i < 3; i += 1) {
      // Lure wording and several recipients: Business is never subject to the Personal checks.
      await expect(send(b.a, await draft(b.a, { subject: 'Verify your account', recipients: 2 }), '203.0.113.9')).resolves.toMatchObject({ status: 'SENT' });
    }
    const sent = mails.slice(first).filter((m) => m.subject.startsWith('Please sign'));
    expect(sent).toHaveLength(6);
    for (const m of sent) {
      expect(m.html).not.toContain('Report this email');
      expect(m.text).not.toContain('/report#');
    }
    expect((await http().post('/v1/sign/report').send({ token: tokenFrom(sent[0]), reason: 'spam' })).status).toBe(404);
    const account = await billing.account(b.a, 'r');
    expect(account.allowance).toMatchObject({ subscribed: true, limit: 100, used: 3 });
    expect('daily' in account.allowance).toBe(false);
    expect(await db.query(`SELECT count(*)::int AS n FROM identity."TenantRiskState" WHERE tenant_id = $1`, [b.id]).then((r) => r.rows[0].n)).toBe(0);
  });
});
