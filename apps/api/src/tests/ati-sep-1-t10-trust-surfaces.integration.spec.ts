import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '@aramo/auth';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoExceptionFilter } from '@aramo/common';
import { EntitlementGuard } from '@aramo/entitlement';
import { identifierDigestOf } from '@aramo/intelligence-contracts';
import { IntelligenceClient, loadIntelligenceConfig, type IntelligenceFetch } from '@aramo/intelligence-integration';

import { VerificationConfirmBudget } from '../controllers/public-verification.controller.js';
import { IntelligenceTrustSurfacesModule } from '../talent-identity/intelligence-trust-surfaces.module.js';

// ATI-SEP-1 T10 WP3b — the recruiter trust surfaces re-pointed onto Talent
// Intelligence, over HTTP against a REAL Postgres 17 (talent_record + consent +
// entitlement). TI itself is a FAKE fetch behind the real IntelligenceClient (the
// ATS reaches TI over HTTP only — no scope:intelligence code is loaded). Proves:
//   * NOT_CONFIGURED / NOT_ENTITLED / TI 503 → reads answer 200 with an empty,
//     honestly-labelled enrichment; actions answer 503 INTELLIGENCE_UNAVAILABLE
//     (details.intelligence_status) — never a 500, and no TI call when gated off;
//   * ENABLED → every route relays the right TI call and maps the shape back
//     (dossier, evidence paging, proposals + server-side slot matching by digest,
//     contradiction KEEP/RETRACT, the 7 dispute routes, email OTP request/status,
//     the public OTP confirm) with TI refusals mapped to ATS codes.
// The module is booted standalone (IntelligenceTrustSurfacesModule) with the JWT
// guard stubbed to inject an AuthContext; RolesGuard runs for real.

const ROOT = resolve(__dirname, '../../../..');
const LIBS_ALL = ['documents', 'talent-evidence', 'talent-record', 'entitlement'];
const CONSENT = [
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
];

function migrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const lib of LIBS_ALL) {
    const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
    }
  }
  for (const p of CONSENT) all.push({ name: p.split('/').at(-2) as string, path: resolve(ROOT, p) });
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000000b2';
const USER = '00000000-0000-7000-8000-00000000c001';
const RECORD = '01900000-0000-7000-8000-00000000a001';
const NO_CONSENT_RECORD = '01900000-0000-7000-8000-0000000000a2';
const ASSERTION = '01900000-0000-7000-8000-0000000000e1';
const DISPUTE = '01900000-0000-7000-8000-0000000000d1';
const PROPOSAL_EMAIL = '01900000-0000-7000-8000-0000000000f1';
const PROPOSAL_PHONE = '01900000-0000-7000-8000-0000000000f2';
const VERIFICATION = '01900000-0000-7000-8000-0000000000c9';
const EMAIL1 = 'Ada.Verify@Example.com';
const EMAIL2 = 'ada.alt@example.org';
const ALL_SCOPES = ['talent:read', 'talent:edit', 'identity:resolve'];
const NOW = '2026-10-23T12:00:00.000Z';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const TRUST = {
  identity_band: 'CORROBORATED',
  claims_band: 'SELF_ASSERTED',
  continuity_band: 'NOT_ESTABLISHED',
  eligibility_band: 'NOT_ESTABLISHED',
  open_contradiction_count: 1,
  stale_assertion_count: 0,
  has_open_dispute: false,
  single_source_only: true,
  verification_stale: false,
};

const PROFILE = {
  intelligence_subject_id: 'subj-1',
  access_mode: 'TENANT_SCOPED',
  trust: TRUST,
  generated_at: NOW,
  facts: [
    { fact_type: 'TITLE', fact_key: '', value: { value: 'Engineer' }, state: 'CONTRADICTED', verification_status: 'DECLARED', corroborating_sources: 1, supporting_assertion_ids: [ASSERTION] },
    { fact_type: 'EMAIL', fact_key: 'ada.verify@example.com', value: { value: 'ada.verify@example.com', verified: true }, state: 'RESOLVED', verification_status: 'VERIFIED', corroborating_sources: 2, supporting_assertion_ids: [] },
  ],
};

function assertion(id: string, observed: string, status = 'VALID') {
  return {
    assertion_id: id,
    assertion_type: 'TITLE',
    admission_class: 'A',
    payload: { value: 'Engineer', years: 3 },
    contributed_by: 'REQUESTING_TENANT',
    source_kind: 'RECRUITER',
    verification_status: 'DECLARED',
    status,
    observed_at: observed,
    valid_from: null,
    valid_to: null,
    ai_derived: false,
    source_document_hash: null,
    history: [{ event_type: 'CREATED', from_status: null, to_status: 'VALID', at: observed }],
  };
}

const EVIDENCE = {
  intelligence_subject_id: 'subj-1',
  access_mode: 'TENANT_SCOPED',
  generated_at: NOW,
  assertions: [
    assertion(ASSERTION, '2026-10-01T00:00:00.000Z', 'CONTRADICTED'),
    assertion('01900000-0000-7000-8000-0000000000e2', '2026-10-05T00:00:00.000Z'),
    assertion('01900000-0000-7000-8000-0000000000e3', '2026-09-01T00:00:00.000Z'),
  ],
};

function proposal(id: string, over: Record<string, unknown>) {
  return {
    proposal_id: id,
    external_talent_ids: [RECORD],
    kind: 'VERIFY_CONTACT',
    trigger_kind: 'SINGLE_SOURCE_ONLY',
    status: 'OPEN',
    assertion_id: null,
    assertion_type: null,
    identifier_type: 'EMAIL',
    identifier_digest: null,
    justification: null,
    action: null,
    created_at: NOW,
    acted_at: null,
    ...over,
  };
}

const SLA = { triage_due_at: NOW, summary_due_at: NOW, reinvestigation_due_at: NOW, reinvestigation_extended_at: null, ccpa_due_at: null, ccpa_extended_due_at: null };
const DISPUTE_SUMMARY = {
  dispute_id: DISPUTE,
  external_talent_ids: [RECORD],
  assertion_id: ASSERTION,
  assertion_type: 'VERIFICATION_OUTCOME',
  contributed_by: 'TALENT_INTELLIGENCE',
  status: 'OPEN',
  opened_at: NOW,
  updated_at: NOW,
  triage_due_at: NOW,
  reinvestigation_due_at: NOW,
};

type Mode = 'ok' | 'down' | 'ti-not-entitled';

/** The fake TI: routes by method + path; `mode` flips the whole surface. */
function fakeTi() {
  const state = { mode: 'ok' as Mode, override: null as null | ((method: string, path: string, body: unknown) => Response | null) };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = vi.fn<IntelligenceFetch>(async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    if (u.pathname === '/v1/oauth/token') return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 900, scope: '' });
    calls.push({ method, path: `${u.pathname}${u.search}`, body });
    if (state.mode === 'down') return json(503, { error: { code: 'UNAVAILABLE', message: 'down' } });
    if (state.mode === 'ti-not-entitled') return json(403, { error: { code: 'NOT_ENTITLED', message: 'no' } });
    const o = state.override?.(method, u.pathname, body);
    if (o !== null && o !== undefined) return o;
    const ref = `/v1/references/ARAMO_ATS/${TENANT}/${RECORD}`;
    if (method === 'GET' && u.pathname === `${ref}/profile`) return json(200, PROFILE);
    if (method === 'GET' && u.pathname === `${ref}/evidence`) return json(200, EVIDENCE);
    if (method === 'GET' && u.pathname === `${ref}/verifications`) {
      return json(200, { items: [{ identifier_type: 'EMAIL', value_masked: 'a***@example.com', status: 'PENDING', expires_at: NOW }] });
    }
    if (method === 'POST' && u.pathname === `${ref}/assertions/${ASSERTION}/contradiction-resolution`) {
      return json(200, { assertion_id: ASSERTION, resolution: (body as { resolution: string }).resolution, status: 'VALID', reconciled_with: [] });
    }
    if (method === 'GET' && u.pathname === `/v1/tenants/${TENANT}/proposals`) {
      return json(200, {
        items: [
          proposal(PROPOSAL_EMAIL, { identifier_digest: identifierDigestOf('EMAIL', EMAIL1) }),
          proposal(PROPOSAL_PHONE, { identifier_type: 'PHONE', identifier_digest: identifierDigestOf('PHONE', '512-555-0100') }),
        ],
        next_cursor: 'c-2',
      });
    }
    if (method === 'POST' && /^\/v1\/proposals\/[^/]+\/(dismiss|act)$/.test(u.pathname)) {
      const id = u.pathname.split('/')[3] as string;
      return json(200, proposal(id, { status: u.pathname.endsWith('dismiss') ? 'DISMISSED' : 'ACTED', identifier_digest: identifierDigestOf('EMAIL', EMAIL1) }));
    }
    if (method === 'GET' && u.pathname === `/v1/tenants/${TENANT}/disputes`) return json(200, { items: [DISPUTE_SUMMARY], next_cursor: null });
    if (method === 'GET' && u.pathname === `/v1/tenants/${TENANT}/disputes/${DISPUTE}`) {
      return json(200, {
        ...DISPUTE_SUMMARY,
        assertion_status: 'VALID',
        assertion_payload: { identifier_type: 'EMAIL' },
        resolution_note: null,
        no_transition_reason: null,
        sla: SLA,
        statements: [{ author: 'TALENT', statement: 'Not mine.', created_at: NOW }],
      });
    }
    if (method === 'POST' && new RegExp(`^/v1/disputes/${DISPUTE}/(triage|request-info|correct|uphold|extend)$`).test(u.pathname)) {
      const action = u.pathname.split('/').at(-1);
      const status = action === 'correct' ? 'RESOLVED_CORRECTED' : action === 'uphold' ? 'RESOLVED_UPHELD' : 'UNDER_REVIEW';
      return json(200, { dispute_id: DISPUTE, status });
    }
    if (method === 'POST' && u.pathname === '/v1/verifications') {
      return json(201, { verification_id: VERIFICATION, channel: 'EMAIL', status: 'PENDING', expires_at: NOW, delivery: 'QUEUED' });
    }
    if (method === 'POST' && u.pathname === `/v1/verifications/${VERIFICATION}/confirm`) {
      const code = (body as { code: string }).code;
      if (code === '123456') return json(200, { verification_id: VERIFICATION, status: 'CONFIRMED', outcome: 'BOUND' });
      return json(422, { error: { code: 'INVALID_CODE', message: 'wrong code', attempts_remaining: 4 } });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  return { state, calls, fetchImpl };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ATI-SEP-1 T10 WP3b — recruiter trust surfaces → Talent Intelligence (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: INestApplication;
  let port = 0;
  const ti = fakeTi();
  const configured = new IntelligenceClient(
    loadIntelligenceConfig({ INTELLIGENCE_SERVICE_URL: 'http://ti.test:3004', INTELLIGENCE_ATS_CLIENT_ID: 'aramo-ats', INTELLIGENCE_ATS_CLIENT_SECRET: 's'.repeat(40) }),
    ti.fetchImpl,
  );
  const unconfigured = new IntelligenceClient(loadIntelligenceConfig({}), ti.fetchImpl);
  let current: IntelligenceClient = configured;
  // The module's IntelligenceClient delegates to `current` (switch per test).
  const switchable = new Proxy({} as IntelligenceClient, {
    get: (_t, k) => {
      const v = (current as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
    },
  });
  let scopes: string[] = ALL_SCOPES;
  const savedEnv: Record<string, string | undefined> = {};

  async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': '1' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  }

  async function grant(tenant: string, ...caps: string[]): Promise<void> {
    for (const c of caps) {
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, $2::entitlement."Capability") ON CONFLICT DO NOTHING`,
        [tenant, c],
      );
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const p of migrations()) await db.query(readFileSync(p, 'utf8'));
    for (const [id, consent] of [
      [RECORD, true],
      [NO_CONSENT_RECORD, false],
    ] as const) {
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name, email1, email2, record_status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Ada', 'Verify', $3, $4, 'live', now(), now())`,
        [id, TENANT, EMAIL1, EMAIL2],
      );
      if (consent) {
        for (const scope of ['profile_storage', 'matching', 'contacting']) {
          await db.query(
            `INSERT INTO consent."TalentConsentEvent"
               (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id, captured_method, consent_version, occurred_at, created_at)
             VALUES ($1, $2::uuid, $3::uuid, $4, 'granted', $5::uuid, 'recruiter_capture', 'v1', now(), now())`,
            [randomUUID(), id, TENANT, scope, USER],
          );
        }
      }
    }

    for (const k of ['DATABASE_URL']) savedEnv[k] = process.env[k];
    process.env['DATABASE_URL'] = url;

    const moduleRef = await Test.createTestingModule({ imports: [IntelligenceTrustSurfacesModule] })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, any> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req['requestId'] = 'test-req';
          if (req['headers']['x-test-auth'] !== '1') return false;
          req['authContext'] = { sub: USER, tenant_id: TENANT, consumer_type: 'recruiter', actor_kind: 'user', scopes };
          return true;
        },
      })
      .overrideGuard(EntitlementGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(IntelligenceClient)
      .useValue(switchable)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AramoExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 120_000);

  beforeEach(async () => {
    await db.query(`TRUNCATE entitlement."TenantEntitlement"`);
    await grant(TENANT, 'core', 'ats');
    current = configured;
    scopes = ALL_SCOPES;
    ti.state.mode = 'ok';
    ti.state.override = null;
    ti.calls.length = 0;
    app.get(VerificationConfirmBudget).reset();
  });

  // ── NOT_CONFIGURED ─────────────────────────────────────────────────────────
  describe('TI not configured', () => {
    beforeEach(async () => {
      current = unconfigured;
      await grant(TENANT, 'intelligence');
    });

    it('reads answer 200 with intelligence_status NOT_CONFIGURED; actions 503; TI is never called', async () => {
      const head = await call('GET', `/v1/talent-records/${RECORD}/dossier`);
      expect(head.status).toBe(200);
      expect(head.body).toMatchObject({ intelligence_status: 'NOT_CONFIGURED', ledger_established: false, facts: [], contradictions: [] });
      expect(head.body.dimensions.identity.band).toBe('NOT_ESTABLISHED');
      const ev = await call('GET', `/v1/talent-records/${RECORD}/dossier/evidence`);
      expect(ev.body).toEqual({ intelligence_status: 'NOT_CONFIGURED', items: [], next_cursor: null });
      expect((await call('GET', '/v1/talent/identity/proposals')).body).toEqual({ intelligence_status: 'NOT_CONFIGURED', items: [], next_cursor: null });
      expect((await call('GET', '/v1/talent/identity/portal-disputes')).body).toEqual({ intelligence_status: 'NOT_CONFIGURED', disputes: [], next_cursor: null });
      const st = await call('GET', `/v1/talent-records/${RECORD}/email-verifications`);
      expect(st.status).toBe(200);
      expect(st.body.intelligence_status).toBe('NOT_CONFIGURED');
      expect(st.body.items.map((i: { status: string }) => i.status)).toEqual(['none', 'none']);

      const act = await call('POST', `/v1/talent/identity/portal-disputes/${DISPUTE}/triage`);
      expect(act.status).toBe(503);
      expect(act.body.error).toMatchObject({ code: 'INTELLIGENCE_UNAVAILABLE', details: { intelligence_status: 'NOT_CONFIGURED' } });
      const req = await call('POST', `/v1/talent-records/${RECORD}/email-verifications`, { slot: 'email1' });
      expect(req.status).toBe(503);
      const confirm = await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '123456' }, false);
      expect(confirm.status).toBe(503);
      expect(ti.calls).toEqual([]);
    });
  });

  // ── NOT_ENTITLED ───────────────────────────────────────────────────────────
  describe('tenant not entitled (no `intelligence` capability)', () => {
    it('reads answer NOT_ENTITLED, actions 503 NOT_ENTITLED, and TI is never called', async () => {
      expect((await call('GET', `/v1/talent-records/${RECORD}/dossier`)).body.intelligence_status).toBe('NOT_ENTITLED');
      expect((await call('GET', '/v1/talent/identity/proposals')).body.intelligence_status).toBe('NOT_ENTITLED');
      const d = await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/dismiss`, { justification: 'n/a' });
      expect(d.status).toBe(503);
      expect(d.body.error.details).toEqual({ intelligence_status: 'NOT_ENTITLED' });
      const c = await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { talent_record_id: RECORD, reason: 'x' });
      expect(c.status).toBe(503);
      expect(ti.calls).toEqual([]);
    });

    it('TI-side NOT_ENTITLED (403) on a read is the same honest NOT_ENTITLED', async () => {
      await grant(TENANT, 'intelligence');
      ti.state.mode = 'ti-not-entitled';
      const head = await call('GET', `/v1/talent-records/${RECORD}/dossier`);
      expect(head.status).toBe(200);
      expect(head.body.intelligence_status).toBe('NOT_ENTITLED');
    });
  });

  // ── TI 503 ─────────────────────────────────────────────────────────────────
  describe('TI unavailable (503)', () => {
    beforeEach(async () => {
      await grant(TENANT, 'intelligence');
      ti.state.mode = 'down';
    });

    it('reads fail soft (200 UNAVAILABLE); actions 503 UNAVAILABLE; never a 500', async () => {
      const head = await call('GET', `/v1/talent-records/${RECORD}/dossier`);
      expect(head.status).toBe(200);
      expect(head.body).toMatchObject({ intelligence_status: 'UNAVAILABLE', ledger_established: false });
      expect((await call('GET', '/v1/talent/identity/proposals')).body.intelligence_status).toBe('UNAVAILABLE');
      expect((await call('GET', '/v1/talent/identity/portal-disputes')).body.intelligence_status).toBe('UNAVAILABLE');
      expect((await call('GET', `/v1/talent-records/${RECORD}/email-verifications`)).body.intelligence_status).toBe('UNAVAILABLE');
      for (const [m, p, b] of [
        ['GET', `/v1/talent/identity/portal-disputes/${DISPUTE}`, undefined],
        ['POST', `/v1/talent/identity/portal-disputes/${DISPUTE}/correct`, { note: 'x' }],
        ['POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/act`, { action: 'RECORD_UPDATED' }],
        ['POST', `/v1/talent-records/${RECORD}/email-verifications`, { slot: 'email1' }],
      ] as const) {
        const r = await call(m, p, b);
        expect(r.status).toBe(503);
        expect(r.body.error).toMatchObject({ code: 'INTELLIGENCE_UNAVAILABLE', details: { intelligence_status: 'UNAVAILABLE' } });
      }
      const confirm = await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '123456' }, false);
      expect(confirm.status).toBe(503);
    });
  });

  // ── ENABLED ────────────────────────────────────────────────────────────────
  describe('TI enabled', () => {
    beforeEach(async () => {
      await grant(TENANT, 'intelligence');
    });

    it('dossier head: bands, statements, facts (contact values stripped), contradictions, verifications', async () => {
      const { status, body } = await call('GET', `/v1/talent-records/${RECORD}/dossier`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        talent_record_id: RECORD,
        intelligence_status: 'ENABLED',
        ledger_established: true,
        dimensions: { identity: { band: 'CORROBORATED' }, claims: { band: 'SELF_ASSERTED' } },
        has_open_dispute: false,
        generated_at: NOW,
      });
      expect(body.statements).toEqual(['All evidence comes from a single source.', 'Some evidence is contradicted and needs review.']);
      const email = body.facts.find((f: { fact_type: string }) => f.fact_type === 'EMAIL');
      expect(email).toEqual({ fact_type: 'EMAIL', fact_key: '', value: {}, state: 'RESOLVED', verification_status: 'VERIFIED', corroborated: true });
      expect(JSON.stringify(body)).not.toContain('ada.verify@example.com');
      expect(body.contradictions).toEqual([
        { assertion_id: ASSERTION, assertion_type: 'TITLE', contributed_by: 'REQUESTING_TENANT', assertion_payload: { value: 'Engineer', years: 3 }, observed_at: '2026-10-01T00:00:00.000Z' },
      ]);
      expect(body.verifications).toEqual([{ anchor_kind: 'EMAIL', status: 'VERIFIED', disputed: false }]);
      expect(ti.calls.map((c) => c.path)).toEqual([
        `/v1/references/ARAMO_ATS/${TENANT}/${RECORD}/profile`,
        `/v1/references/ARAMO_ATS/${TENANT}/${RECORD}/evidence`,
      ]);
    });

    it('dossier for a record TI does not know (404) → ENABLED, ledger_established:false', async () => {
      const unknown = '01900000-0000-7000-8000-0000000000a9';
      const { status, body } = await call('GET', `/v1/talent-records/${unknown}/dossier`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ intelligence_status: 'ENABLED', ledger_established: false });
    });

    it('dossier evidence: newest first, paged by an opaque cursor', async () => {
      const p1 = await call('GET', `/v1/talent-records/${RECORD}/dossier/evidence?limit=2`);
      expect(p1.status).toBe(200);
      expect(p1.body.items.map((i: { observed_at: string }) => i.observed_at)).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
      expect(p1.body.items[0]).toMatchObject({ contributed_by: 'REQUESTING_TENANT', history: [{ event_type: 'CREATED' }] });
      expect(typeof p1.body.next_cursor).toBe('string');
      const p2 = await call('GET', `/v1/talent-records/${RECORD}/dossier/evidence?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.next_cursor).toBeNull();
    });

    it('proposals: record pointer + the email slot matched SERVER-side by digest; PHONE deep-links', async () => {
      const { status, body } = await call('GET', '/v1/talent/identity/proposals?kind=VERIFY_CONTACT&limit=10');
      expect(status).toBe(200);
      expect(body.intelligence_status).toBe('ENABLED');
      expect(body.next_cursor).toBe('c-2');
      const [email, phone] = body.items;
      expect(email).toMatchObject({ id: PROPOSAL_EMAIL, kind: 'VERIFY_CONTACT', record_id: RECORD, slot: 'email1', identifier_type: 'EMAIL', basis_kinds: ['EMAIL'] });
      expect(phone.record_id).toBe(RECORD);
      expect(phone.slot).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/digest|[a-f0-9]{64}/);
      expect(ti.calls[0]!.path).toBe(`/v1/tenants/${TENANT}/proposals?status=OPEN&kind=VERIFY_CONTACT&limit=10`);
      expect((await call('GET', '/v1/talent/identity/proposals?status=BOGUS')).status).toBe(400);
    });

    it('dismiss / act relay tenant + actor (JWT) to TI', async () => {
      const d = await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/dismiss`, { justification: 'handled' });
      expect(d.status).toBe(200);
      expect(d.body).toMatchObject({ id: PROPOSAL_EMAIL, status: 'DISMISSED', slot: 'email1' });
      expect(ti.calls.at(-1)).toEqual({ method: 'POST', path: `/v1/proposals/${PROPOSAL_EMAIL}/dismiss`, body: { source_tenant_id: TENANT, actor: USER, justification: 'handled' } });
      const a = await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/act`, { action: 'VERIFICATION_REQUESTED', note: 'sent' });
      expect(a.status).toBe(200);
      expect(ti.calls.at(-1)!.body).toEqual({ source_tenant_id: TENANT, actor: USER, action: 'VERIFICATION_REQUESTED', note: 'sent' });
      // No action named → defaulted from the proposal kind (VERIFY_CONTACT).
      await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/act`, {});
      expect(ti.calls.at(-1)!.body).toEqual({ source_tenant_id: TENANT, actor: USER, action: 'VERIFICATION_REQUESTED' });
      ti.state.override = (m, p) => (m === 'POST' && p.endsWith('/dismiss') ? json(409, { error: { code: 'PROPOSAL_NOT_OPEN', message: 'closed' } }) : null);
      const again = await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/dismiss`, { justification: 'again' });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PROPOSAL_NOT_OPEN');
      expect((await call('POST', `/v1/talent/identity/proposals/${PROPOSAL_EMAIL}/dismiss`, {})).status).toBe(400);
    });

    it('the worklist needs talent:read (RolesGuard)', async () => {
      scopes = [];
      expect((await call('GET', '/v1/talent/identity/proposals')).status).toBe(403);
    });

    it('contradiction resolve: KEEP by default, RETRACT on request; TI refusal → 422 EVIDENCE_NOT_CONTRADICTED; 404 uniform', async () => {
      const keep = await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { talent_record_id: RECORD, reason: 'distinct roles' });
      expect(keep.status).toBe(200);
      expect(keep.body).toEqual({ status: 'RESOLVED', assertion_id: ASSERTION, resolution: 'KEEP', assertion_status: 'VALID' });
      expect(ti.calls.at(-1)).toEqual({
        method: 'POST',
        path: `/v1/references/ARAMO_ATS/${TENANT}/${RECORD}/assertions/${ASSERTION}/contradiction-resolution`,
        body: { resolution: 'KEEP', reason: 'distinct roles', actor: USER },
      });
      const retract = await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { talent_record_id: RECORD, reason: 'wrong', resolution: 'RETRACT' });
      expect(retract.body.resolution).toBe('RETRACT');
      ti.state.override = () => json(422, { error: { code: 'ASSERTION_NOT_CONTRADICTED', message: 'not contradicted' } });
      const nc = await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { talent_record_id: RECORD, reason: 'x' });
      expect(nc.status).toBe(422);
      expect(nc.body.error).toMatchObject({ code: 'EVIDENCE_NOT_CONTRADICTED', details: { reason: 'ASSERTION_NOT_CONTRADICTED' } });
      ti.state.override = () => json(404, { error: { code: 'REFERENCE_NOT_FOUND', message: 'no' } });
      const nf = await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { talent_record_id: RECORD, reason: 'x' });
      expect(nf.status).toBe(404);
      expect(nf.body.error.code).toBe('NOT_FOUND');
      // The record is required (the tenant resolves through its own reference).
      expect((await call('POST', `/v1/talent/identity/contradictions/${ASSERTION}/resolve`, { reason: 'x' })).status).toBe(400);
    });

    it('portal disputes: worklist, detail and the five dispositions relay to TI', async () => {
      const list = await call('GET', '/v1/talent/identity/portal-disputes?all=1');
      expect(list.status).toBe(200);
      expect(list.body.disputes).toEqual([
        {
          dispute_id: DISPUTE,
          talent_record_ids: [RECORD],
          assertion_id: ASSERTION,
          item_type: 'VERIFICATION_OUTCOME',
          contributed_by: 'TALENT_INTELLIGENCE',
          status: 'OPEN',
          arrived_at: NOW,
          updated_at: NOW,
          triage_due_at: NOW,
          reinvestigation_due_at: NOW,
        },
      ]);
      expect(ti.calls.at(-1)!.path).toBe(`/v1/tenants/${TENANT}/disputes?status=all&limit=100`);
      const detail = await call('GET', `/v1/talent/identity/portal-disputes/${DISPUTE}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ dispute_id: DISPUTE, assertion_status: 'VALID', statements: [{ author: 'TALENT', statement: 'Not mine.' }] });
      for (const [action, body, expected] of [
        ['triage', undefined, { source_tenant_id: TENANT, actor: USER }],
        ['request-info', { note: 'more?' }, { source_tenant_id: TENANT, actor: USER, note: 'more?' }],
        ['correct', { note: 'fixed' }, { source_tenant_id: TENANT, actor: USER, note: 'fixed' }],
        ['uphold', { note: 'stands' }, { source_tenant_id: TENANT, actor: USER, note: 'stands' }],
        ['extend', undefined, { source_tenant_id: TENANT, actor: USER }],
      ] as const) {
        const r = await call('POST', `/v1/talent/identity/portal-disputes/${DISPUTE}/${action}`, body);
        expect(r.status).toBe(200);
        expect(r.body.dispute_id).toBe(DISPUTE);
        expect(ti.calls.at(-1)).toEqual({ method: 'POST', path: `/v1/disputes/${DISPUTE}/${action}`, body: expected });
      }
      ti.state.override = (m, p) => (p.endsWith('/extend') ? json(422, { error: { code: 'DISPUTE_EXTENSION_USED', message: 'used' } }) : null);
      const ext = await call('POST', `/v1/talent/identity/portal-disputes/${DISPUTE}/extend`);
      expect(ext.status).toBe(422);
      expect(ext.body.error.code).toBe('PORTAL_DISPUTE_EXTENSION_USED');
      const missing = await call('GET', `/v1/talent/identity/portal-disputes/01900000-0000-7000-8000-0000000000d9`);
      expect(missing.status).toBe(404);
      expect((await call('POST', `/v1/talent/identity/portal-disputes/${DISPUTE}/correct`, {})).status).toBe(400);
    });

    it('email verification: consent gate first; then TI mints the code for the STORED address; status matches by mask', async () => {
      const refused = await call('POST', `/v1/talent-records/${NO_CONSENT_RECORD}/email-verifications`, { slot: 'email1' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('VERIFICATION_CONSENT_REQUIRED');
      expect(ti.calls).toEqual([]);

      const ok = await call('POST', `/v1/talent-records/${RECORD}/email-verifications`, { slot: 'email1' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ verification_id: VERIFICATION, slot: 'email1', status: 'PENDING', expires_at: NOW, delivery: 'QUEUED' });
      expect(ti.calls.at(-1)).toEqual({
        method: 'POST',
        path: '/v1/verifications',
        body: {
          source_reference: { source_system_id: 'ARAMO_ATS', source_tenant_id: TENANT, external_talent_id: RECORD },
          identifier_type: 'EMAIL',
          value: EMAIL1,
        },
      });
      // A caller-supplied address is structurally impossible.
      expect((await call('POST', `/v1/talent-records/${RECORD}/email-verifications`, { slot: 'email1', email: 'x@evil.test' })).status).toBe(400);
      expect((await call('POST', `/v1/talent-records/${randomUUID()}/email-verifications`, { slot: 'email1' })).status).toBe(404);

      const st = await call('GET', `/v1/talent-records/${RECORD}/email-verifications`);
      expect(st.status).toBe(200);
      expect(st.body).toEqual({
        intelligence_status: 'ENABLED',
        items: [
          { slot: 'email1', value_present: true, status: 'pending', expires_at: NOW },
          { slot: 'email2', value_present: true, status: 'none', expires_at: null },
        ],
      });
    });

    it('public OTP confirm: 200 VERIFIED; wrong code 422 + attempts; unknown id 404; malformed 400; per-IP budget 404', async () => {
      const ok = await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '123456' }, false);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ status: 'VERIFIED' });
      expect(ti.calls.at(-1)).toEqual({ method: 'POST', path: `/v1/verifications/${VERIFICATION}/confirm`, body: { code: '123456' } });
      const wrong = await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '000000' }, false);
      expect(wrong.status).toBe(422);
      expect(wrong.body.error).toMatchObject({ code: 'IDENTIFIER_VERIFICATION_REFUSED', details: { reason: 'INVALID_CODE', attempts_remaining: 4 } });
      const unknown = await call('POST', '/v1/email-verifications/confirm', { verification_id: randomUUID(), code: '123456' }, false);
      expect(unknown.status).toBe(404);
      expect((await call('POST', '/v1/email-verifications/confirm', { verification_id: 'nope', code: '123456' }, false)).status).toBe(400);
      expect((await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '12' }, false)).status).toBe(400);
      expect((await call('POST', '/v1/email-verifications/confirm', { token: 'legacy' }, false)).status).toBe(400);
      // 6 calls so far in this window; the 11th is over budget → the uniform 404.
      for (let i = 0; i < 4; i += 1) await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '123456' }, false);
      const over = await call('POST', '/v1/email-verifications/confirm', { verification_id: VERIFICATION, code: '123456' }, false);
      expect(over.status).toBe(404);
    });
  });

  it('a tenant never reaches another tenant: every TI call is keyed by the JWT tenant', async () => {
    await grant(TENANT, 'intelligence');
    await grant(OTHER_TENANT, 'core', 'ats', 'intelligence');
    await call('GET', `/v1/talent-records/${RECORD}/dossier`);
    await call('GET', '/v1/talent/identity/proposals');
    await call('GET', '/v1/talent/identity/portal-disputes');
    for (const c of ti.calls) expect(c.path).not.toContain(OTHER_TENANT);
    expect(ti.calls.every((c) => c.path.includes(TENANT))).toBe(true);
  });
});
