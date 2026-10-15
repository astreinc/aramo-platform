import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import {
  STRUCTURED_GENERATION_PROVIDER,
  type StructuredGenerationOutcome,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
} from '@aramo/ai-draft';

import { AppModule } from '../../app.module.js';
import { ConfigurableTestResolver } from '../support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from '../write-freeze-tenant.js';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8/§9/§13) — the Technical
// Screening HTTP surface through the REAL AppModule + guards against real
// Postgres 17, publishing through the REAL Talent Trust writer
// (Aramo-TR-SCREEN-1-DDR §3). Rows 1–4, 7, 10, 12, 14, 15, 21–23, 35, 39 (HTTP),
// 42, 44, 45, 51.

const __authz = new ConfigurableTestResolver();

// INC-3 A1-3 — a deterministic stand-in for the tenant LLM (no provider key in
// tests). It answers by schema name and records every request it receives.
class FakeTenantLlm implements StructuredGenerationProvider {
  requests: StructuredGenerationRequest[] = [];
  providerKey(): string {
    return 'anthropic';
  }
  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome> {
    this.requests.push(request);
    const transport = { model_used: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1, provider_request_id: 'fake-req' };
    if (request.schema_name === 'screening_question_plan') {
      return {
        kind: 'ok',
        parsed: {
          questions: [
            { text: 'Walk me through a rollback you ran.', skill_ref: 'Kubernetes' },
            { text: 'How do you size node pools?', skill_ref: 'Kubernetes' },
          ],
        },
        transport,
      };
    }
    if (request.schema_name === 'screening_follow_up') {
      return { kind: 'ok', parsed: { suggestions: ['Which storage class did you choose, and why?'] }, transport };
    }
    return { kind: 'terminal', category: 'invalid_request' };
  }
}
const fakeLlm = new FakeTenantLlm();
type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-inc3-screening-spec';
const TENANT = '01900000-0000-7000-8000-00000000c3a1';
const OTHER_TENANT = '01900000-0000-7000-8000-00000000c3a2';
const NO_ATS_TENANT = '01900000-0000-7000-8000-00000000c3a3';
const SITE_1 = '01900000-0000-7000-8000-00000000c3b1';
const SITE_2 = '01900000-0000-7000-8000-00000000c3b2';
const RECRUITER = '01900000-0000-7000-8000-00000000c3c1';
const FOREIGN_ADMIN = '01900000-0000-7000-8000-00000000c3c2';
const ALL = ['screening:read', 'screening:create', 'screening:edit', 'screening:confirm'];

function allMigrations(): string[] {
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    const migDir = resolve(libs, lib, 'prisma', 'migrations');
    let entries: string[];
    try {
      entries = readdirSync(migDir);
    } catch {
      continue;
    }
    for (const d of entries) {
      const file = resolve(migDir, d, 'migration.sql');
      try {
        readFileSync(file);
      } catch {
        continue;
      }
      out.push({ ts: d, path: file });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.map((o) => o.path);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TIP-E2E INC-3 — technical screening HTTP (real AppModule + Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};

    async function jwt(opts: {
      scopes: string[];
      tenant?: string;
      sub?: string;
      consumer?: string;
      site?: string;
    }): Promise<string> {
      const tenant = opts.tenant ?? TENANT;
      const sub = opts.sub ?? RECRUITER;
      const claims: Record<string, unknown> = {
        sub,
        consumer_type: opts.consumer ?? 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        authz_version: __authz.grant(tenant, sub, opts.scopes),
      };
      if (opts.site !== undefined) claims['site_id'] = opts.site;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function call(
      method: string,
      path: string,
      token: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const codeOf = (b: Record<string, unknown>): string | undefined =>
      (b['error'] as Record<string, unknown> | undefined)?.['code'] as string | undefined;

    async function talent(tenant: string = TENANT, site: string | null = SITE_1, status = 'live'): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, site_id, first_name, last_name, record_status) VALUES ($1::uuid,$2::uuid,$3::uuid,'Ada','Lovelace',$4)`,
        [id, tenant, site, status],
      );
      return id;
    }

    const SESSIONS = (t: string): string => `/v1/talent-records/${t}/screening-sessions`;
    const S = (id: string, rest = ''): string => `/v1/screening-sessions/${id}${rest}`;

    // Create a DRAFT with one finding; returns ids + the current version.
    async function draftWithFinding(token: string, talentId: string, f: Record<string, unknown> = {}) {
      const created = await call('POST', SESSIONS(talentId), token, {});
      expect(created.status).toBe(201);
      const id = created.body['id'] as string;
      const added = await call('POST', S(id, '/findings'), token, {
        version: 1,
        skill_raw: 'Kubernetes',
        basis: 'RECRUITER_OBSERVED',
        observation_raw: 'Explained pod disruption budgets during a rollout.',
        ...f,
      });
      expect(added.status).toBe(201);
      const findings = added.body['findings'] as Array<{ id: string }>;
      const version = (added.body['session'] as { version: number }).version;
      return { id, findingId: findings[0]!.id, version };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT, OTHER_TENANT, NO_ATS_TENANT]) {
        await ensureWriteFreezeTenant((sql) => db.query(sql), t, 'ACTIVE');
      }
      for (const t of [TENANT, OTHER_TENANT]) {
        // 'ats' gates the screening routes; 'core' gates the TR-15 dispute routes.
        for (const capability of ['ats', 'core']) {
          await db.query(
            `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`,
            [t, capability],
          );
        }
      }
      const kp = await generateKeyPair('RS256');
      privateKey = kp.privateKey as SignKey;
      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'MAILER_PROVIDER'] as const) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey as never);
      process.env['MAILER_PROVIDER'] = 'stub';
      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authz)
        .overrideProvider(STRUCTURED_GENERATION_PROVIDER)
        .useValue(fakeLlm)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('end to end: draft → confirm (attested) → published SCREENING_FINDING evidence with honest provenance', async () => {
      const token = await jwt({ scopes: ALL });
      const talentId = await talent();
      const { id, findingId, version } = await draftWithFinding(token, talentId);
      const confirmed = await call(
        'POST',
        S(id, '/confirm'),
        token,
        { version, confirmed_finding_ids: [findingId], observations_confirmed: true },
        { 'Idempotency-Key': uuidv7() },
      );
      expect(confirmed.status).toBe(200);
      expect((confirmed.body['session'] as Record<string, unknown>)['state']).toBe('CONFIRMED');
      const pubs = confirmed.body['publications'] as Array<Record<string, unknown>>;
      expect(pubs).toHaveLength(1);
      expect(pubs[0]!['state']).toBe('PUBLISHED');
      expect(pubs[0]!['trust_status']).toBe('VALID');

      const ev = await db.query<Record<string, unknown>>(
        `SELECT assertion_type, source_class, method, ai_derived, created_by, assertion_payload FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`,
        [pubs[0]!['evidence_record_id']],
      );
      expect(ev.rows[0]).toMatchObject({
        assertion_type: 'SCREENING_FINDING',
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'HUMAN_ATTESTED',
        ai_derived: false,
        created_by: 'technical-screening',
      });
      // Row 51 — no actor identifier on the evidence wire; the real recruiter id
      // lives only in the screening domain.
      expect(JSON.stringify(ev.rows[0]!['assertion_payload'])).not.toContain(RECRUITER);
      const evt = await db.query<{ actor: string }>(
        `SELECT actor FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid`,
        [pubs[0]!['evidence_record_id']],
      );
      expect(evt.rows.map((r) => r.actor)).toEqual(['technical-screening']);
      expect((confirmed.body['session'] as Record<string, unknown>)['confirmed_by_actor_id']).toBe(RECRUITER);

      // Row 21 — screening writes nothing into Examination / Pipeline / Submittal.
      for (const table of ['examination."TalentJobExamination"', 'pipeline."Pipeline"', 'submittal."TalentSubmittalRecord"']) {
        const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(r.rows[0]!.n).toBe(0);
      }
    });

    it('confirm replay with the same Idempotency-Key returns the cached response (row 12)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      const key = uuidv7();
      const body = { version, confirmed_finding_ids: [findingId], observations_confirmed: true };
      const first = await call('POST', S(id, '/confirm'), token, body, { 'Idempotency-Key': key });
      const replay = await call('POST', S(id, '/confirm'), token, body, { 'Idempotency-Key': key });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      const n = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM technical_screening."ScreeningEvidencePublication" WHERE session_id = $1::uuid`,
        [id],
      );
      expect(n.rows[0]!.n).toBe(1);
    });

    it('confirm refusals over HTTP: no attestation 422, zero findings 400, stale version 409, missing key 400 (rows 8–10)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      const k = (): Record<string, string> => ({ 'Idempotency-Key': uuidv7() });
      const noAttest = await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [findingId], observations_confirmed: false }, k());
      expect([noAttest.status, codeOf(noAttest.body)]).toEqual([422, 'ATTESTATION_MISSING']);
      const zero = await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [], observations_confirmed: true }, k());
      expect([zero.status, codeOf(zero.body)]).toEqual([400, 'VALIDATION_ERROR']);
      const stale = await call('POST', S(id, '/confirm'), token, { version: version - 1, confirmed_finding_ids: [findingId], observations_confirmed: true }, k());
      expect([stale.status, codeOf(stale.body)]).toEqual([409, 'SCREENING_SESSION_VERSION_CONFLICT']);
      const noKey = await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [findingId], observations_confirmed: true });
      expect(noKey.status).toBe(400);
    });

    it('after confirm: edit / remove / void are 422 SCREENING_SESSION_STATE_INVALID (row 15)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [findingId], observations_confirmed: true }, { 'Idempotency-Key': uuidv7() });
      const v = version + 1;
      const edit = await call('PATCH', S(id, `/findings/${findingId}`), token, { version: v, skill_raw: 'x', basis: 'RECRUITER_OBSERVED', observation_raw: 'y' });
      const del = await call('DELETE', S(id, `/findings/${findingId}?version=${v}`), token);
      const voided = await call('POST', S(id, '/void'), token, { version: v });
      for (const r of [edit, del, voided]) expect([r.status, codeOf(r.body)]).toEqual([422, 'SCREENING_SESSION_STATE_INVALID']);
    });

    it('cross-tenant + cross-site ids are the SAME 404 as an absent id (rows 1, 2)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id } = await draftWithFinding(token, await talent());
      const foreign = await jwt({ scopes: ALL, tenant: OTHER_TENANT, sub: FOREIGN_ADMIN });
      const absent = await call('GET', S(uuidv7()), token);
      const crossTenant = await call('GET', S(id), foreign);
      expect([absent.status, codeOf(absent.body)]).toEqual([404, 'NOT_FOUND']);
      expect([crossTenant.status, codeOf(crossTenant.body)]).toEqual([404, 'NOT_FOUND']);
      const crossTenantWrite = await call('POST', S(id, '/findings'), foreign, { version: 2, skill_raw: 'x', basis: 'RECRUITER_OBSERVED', observation_raw: 'y' });
      expect([crossTenantWrite.status, codeOf(crossTenantWrite.body)]).toEqual([404, 'NOT_FOUND']);
      // A site-2 actor cannot reach a site-1 talent or its sessions.
      const site2 = await jwt({ scopes: ALL, site: SITE_2 });
      const s2read = await call('GET', S(id), site2);
      const s2create = await call('POST', SESSIONS(await talent(TENANT, SITE_1)), site2, {});
      expect([s2read.status, s2create.status]).toEqual([404, 404]);
      const site1 = await jwt({ scopes: ALL, site: SITE_1 });
      expect((await call('GET', S(id), site1)).status).toBe(200);
    });

    it('per-route scope, recruiter-only and ats entitlement are enforced server-side (rows 3, 4, 7, 22, 42)', async () => {
      const full = await jwt({ scopes: ALL });
      const talentId = await talent();
      const { id, findingId, version } = await draftWithFinding(full, talentId);
      const readOnly = await jwt({ scopes: ['screening:read'] });
      expect((await call('GET', S(id), readOnly)).status).toBe(200);
      const denied = [
        await call('POST', SESSIONS(talentId), readOnly, {}),
        await call('POST', S(id, '/findings'), readOnly, { version, skill_raw: 'x', basis: 'RECRUITER_OBSERVED', observation_raw: 'y' }),
        await call('POST', S(id, '/confirm'), await jwt({ scopes: ['screening:read', 'screening:edit'] }), { version, confirmed_finding_ids: [findingId], observations_confirmed: true }, { 'Idempotency-Key': uuidv7() }),
        await call('POST', S(id, '/publish'), readOnly, undefined, { 'Idempotency-Key': uuidv7() }),
        await call('GET', S(id), await jwt({ scopes: [] })),
      ];
      for (const r of denied) expect([r.status, codeOf(r.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
      // Row 42 — a tenant_admin-like principal holding the tenant's admin scopes
      // but NOT screening scopes is refused on every screening route.
      const admin = await jwt({ scopes: ['identity:resolve', 'talent:read', 'talent:edit'] });
      expect((await call('GET', SESSIONS(talentId), admin)).status).toBe(403);
      expect((await call('POST', SESSIONS(talentId), admin, {})).status).toBe(403);
      // Row 7 — a non-recruiter consumer.
      const ingestion = await jwt({ scopes: ALL, consumer: 'ingestion' });
      expect((await call('GET', S(id), ingestion)).status).toBe(403);
      // Row 3 — tenant without the ats capability.
      const noAts = await jwt({ scopes: ALL, tenant: NO_ATS_TENANT });
      const r = await call('GET', SESSIONS(talentId), noAts);
      expect([r.status, codeOf(r.body)]).toEqual([403, 'TENANT_CAPABILITY_NOT_ENTITLED']);
    });

    it('a superseded TalentRecord refuses new screening (row 23)', async () => {
      const token = await jwt({ scopes: ALL });
      const husk = await talent(TENANT, SITE_1, 'superseded');
      const r = await call('POST', SESSIONS(husk), token, {});
      expect([r.status, codeOf(r.body)]).toEqual([422, 'TALENT_RECORD_SUPERSEDED']);
    });

    it('trust failure after confirm leaves CONFIRMED + PENDING; /publish retries with no re-attestation (row 14)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      // Make the trust write fail transiently: a trigger rejecting inserts.
      await db.query(`CREATE OR REPLACE FUNCTION talent_trust.inc3_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'inc3 test block'; END; $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER inc3_block BEFORE INSERT ON talent_trust."EvidenceRecord" FOR EACH ROW EXECUTE FUNCTION talent_trust.inc3_block()`);
      try {
        const confirmed = await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [findingId], observations_confirmed: true }, { 'Idempotency-Key': uuidv7() });
        expect(confirmed.status).toBe(200);
        expect((confirmed.body['session'] as Record<string, unknown>)['state']).toBe('CONFIRMED');
        const p = (confirmed.body['publications'] as Array<Record<string, unknown>>)[0]!;
        expect(p['state']).toBe('PENDING');
        expect(p['attempt_count']).toBe(1);
        expect(p['trust_status']).toBeNull();
        const evidence = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`, [p['evidence_record_id']]);
        expect(evidence.rows[0]!.n).toBe(0);
      } finally {
        await db.query(`DROP TRIGGER inc3_block ON talent_trust."EvidenceRecord"`);
        await db.query(`DROP FUNCTION talent_trust.inc3_block()`);
      }
      const retry = await call('POST', S(id, '/publish'), token, undefined, { 'Idempotency-Key': uuidv7() });
      expect(retry.status).toBe(200);
      const p = (retry.body['publications'] as Array<Record<string, unknown>>)[0]!;
      expect([p['state'], p['trust_status']]).toEqual(['PUBLISHED', 'VALID']);
    });

    it('a published finding contested via TR-15: upheld → REVOKED, session stays CONFIRMED (row 44); cross-tenant dispute refused 404 (row 45)', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      const confirmed = await call('POST', S(id, '/confirm'), token, { version, confirmed_finding_ids: [findingId], observations_confirmed: true }, { 'Idempotency-Key': uuidv7() });
      const evidenceId = (confirmed.body['publications'] as Array<Record<string, unknown>>)[0]!['evidence_record_id'] as string;

      // Row 45 (MANDATORY) — a foreign tenant's identity:resolve holder cannot
      // raise a dispute on it: 404 indistinguishable from absent, no event, no change.
      const foreign = await jwt({ scopes: ['identity:resolve'], tenant: OTHER_TENANT, sub: FOREIGN_ADMIN });
      const cross = await call('POST', `/v1/talent/identity/disputes/${evidenceId}/raise`, foreign, { grounds: 'x' });
      const absent = await call('POST', `/v1/talent/identity/disputes/${uuidv7()}/raise`, foreign, { grounds: 'x' });
      expect([cross.status, codeOf(cross.body)]).toEqual([absent.status, codeOf(absent.body)]);
      expect(cross.status).toBe(404);
      const events = await db.query<{ event_type: string }>(`SELECT event_type FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid`, [evidenceId]);
      expect(events.rows.map((e) => e.event_type)).toEqual(['CREATED']);

      // Row 44 — the owning tenant's dispute, upheld.
      const resolver = await jwt({ scopes: ['identity:resolve', ...ALL] });
      expect((await call('POST', `/v1/talent/identity/disputes/${evidenceId}/raise`, resolver, { grounds: 'talent objects' })).status).toBe(200);
      expect((await call('POST', `/v1/talent/identity/disputes/${evidenceId}/resolve`, resolver, { outcome: 'upheld', justification: 'observation was wrong' })).status).toBe(200);
      const after = await call('GET', S(id), resolver);
      expect((after.body['session'] as Record<string, unknown>)['state']).toBe('CONFIRMED');
      expect((after.body['publications'] as Array<Record<string, unknown>>)[0]!['trust_status']).toBe('REVOKED');
    });

    it('DRAFT editing over HTTP: add, edit (DEMONSTRATED needs text), remove, void', async () => {
      const token = await jwt({ scopes: ALL });
      const { id, findingId, version } = await draftWithFinding(token, await talent());
      const bad = await call('PATCH', S(id, `/findings/${findingId}`), token, { version, skill_raw: 'Go', basis: 'DEMONSTRATED', observation_raw: 'x' });
      expect([bad.status, codeOf(bad.body)]).toEqual([400, 'VALIDATION_ERROR']);
      const ok = await call('PATCH', S(id, `/findings/${findingId}`), token, { version, skill_raw: 'Go', basis: 'DEMONSTRATED', observation_raw: 'x', demonstration_raw: 'Profiled a leak live.' });
      expect(ok.status).toBe(200);
      const v2 = (ok.body['session'] as { version: number }).version;
      const removed = await call('DELETE', S(id, `/findings/${findingId}?version=${v2}`), token);
      expect(removed.status).toBe(200);
      expect(removed.body['findings']).toEqual([]);
      const v3 = (removed.body['session'] as { version: number }).version;
      const voided = await call('POST', S(id, '/void'), token, { version: v3, reason: 'opened in error' });
      expect((voided.body['session'] as Record<string, unknown>)['state']).toBe('VOIDED');
      const list = await call('GET', SESSIONS((voided.body['session'] as { talent_record_id: string }).talent_record_id), token);
      expect((list.body['items'] as unknown[]).length).toBe(1);
    });

    // ---- INC-3 A1-2 / A1-3 ---------------------------------------------------

    async function grantAiProcessing(talentId: string, tenant: string = TENANT): Promise<void> {
      await db.query(
        `INSERT INTO consent."TalentConsentEvent" (id, talent_record_id, tenant_id, scope, action, captured_method, consent_version, occurred_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'ai_processing','granted','recruiter_attestation','ai-processing-notice-v1',now())`,
        [uuidv7(), talentId, tenant],
      );
    }

    it('A1: an optional requisition outside visibility (absent) is a 404 at create', async () => {
      const token = await jwt({ scopes: ALL });
      const r = await call('POST', SESSIONS(await talent()), token, { requisition_id: uuidv7() });
      expect([r.status, codeOf(r.body)]).toEqual([404, 'NOT_FOUND']);
    });

    it('A1 R-A: question generation with the talent profile fails closed without ai_processing (no model call); requisition-less + profile-less is 400', async () => {
      const token = await jwt({ scopes: ALL });
      const { id } = await draftWithFinding(token, await talent());
      const before = fakeLlm.requests.length;
      const denied = await call('POST', S(id, '/questions/generate'), token, {});
      expect([denied.status, codeOf(denied.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
      expect(fakeLlm.requests.length).toBe(before);
      const nothing = await call('POST', S(id, '/questions/generate'), token, { include_talent_profile: false });
      expect([nothing.status, codeOf(nothing.body)]).toEqual([400, 'VALIDATION_ERROR']);
    });

    it('A1: with ai_processing granted the plan is generated with honest provenance; the recruiter edits, selects, removes and adds questions', async () => {
      const token = await jwt({ scopes: ALL });
      const talentId = await talent();
      await grantAiProcessing(talentId);
      const { id } = await draftWithFinding(token, talentId);
      const gen = await call('POST', S(id, '/questions/generate'), token, {});
      expect(gen.status).toBe(201);
      const questions = gen.body['questions'] as Array<Record<string, unknown>>;
      expect(questions.map((q) => [q['origin'], q['status']])).toEqual([
        ['AI_GENERATED', 'PROPOSED'],
        ['AI_GENERATED', 'PROPOSED'],
      ]);
      const generations = gen.body['generations'] as Array<Record<string, unknown>>;
      expect(generations[0]).toMatchObject({ kind: 'QUESTION_PLAN', model: 'claude-sonnet-4-6', used_talent_profile: true });
      // The talent profile sent to the model carries no contact or name data.
      expect(fakeLlm.requests.at(-1)!.user_content).not.toContain('Lovelace');
      const q1 = questions[0]!['id'] as string;
      const q2 = questions[1]!['id'] as string;
      const edited = await call('PATCH', S(id, `/questions/${q1}`), token, { text: 'Walk me through the last rollback you ran.', status: 'SELECTED' });
      expect((edited.body['questions'] as Array<Record<string, unknown>>).find((q) => q['id'] === q1)).toMatchObject({ edited: true, status: 'SELECTED' });
      const removed = await call('PATCH', S(id, `/questions/${q2}`), token, { status: 'REMOVED' });
      expect((removed.body['questions'] as Array<Record<string, unknown>>).find((q) => q['id'] === q2)?.['status']).toBe('REMOVED');
      const own = await call('POST', S(id, '/questions'), token, { text: 'What did you own end to end?' });
      expect(own.status).toBe(201);
      expect((own.body['questions'] as Array<Record<string, unknown>>).some((q) => q['origin'] === 'RECRUITER_AUTHORED')).toBe(true);
    });

    it('A1 G-4: recruiter-notes mode — a note drives AI follow-up suggestions (consent-gated); an action is recorded once', async () => {
      const token = await jwt({ scopes: ALL });
      const noConsent = await talent();
      const s1 = await draftWithFinding(token, noConsent);
      const n1 = await call('POST', S(s1.id, '/notes'), token, { body: 'Vague on storage.' });
      expect(n1.status).toBe(201);
      const deniedSuggest = await call('POST', S(s1.id, '/suggestions'), token, { note_id: (n1.body['notes'] as Array<{ id: string }>)[0]!.id });
      expect([deniedSuggest.status, codeOf(deniedSuggest.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);

      const consented = await talent();
      await grantAiProcessing(consented);
      const s2 = await draftWithFinding(token, consented);
      const n2 = await call('POST', S(s2.id, '/notes'), token, { body: 'Vague on storage.' });
      const sug = await call('POST', S(s2.id, '/suggestions'), token, { note_id: (n2.body['notes'] as Array<{ id: string }>)[0]!.id });
      expect(sug.status).toBe(201);
      const suggestion = (sug.body['suggestions'] as Array<Record<string, unknown>>)[0]!;
      expect(suggestion).toMatchObject({ trigger_kind: 'NOTE', action: null });
      const used = await call('PATCH', S(s2.id, `/suggestions/${suggestion['id']}`), token, { action: 'USED' });
      expect((used.body['suggestions'] as Array<Record<string, unknown>>)[0]!['action']).toBe('USED');
      const again = await call('PATCH', S(s2.id, `/suggestions/${suggestion['id']}`), token, { action: 'DISMISSED' });
      expect(again.status).toBe(409);
    });

    it('A1: the new routes keep tenant concealment and per-route scopes', async () => {
      const token = await jwt({ scopes: ALL });
      const { id } = await draftWithFinding(token, await talent());
      const foreign = await jwt({ scopes: ALL, tenant: OTHER_TENANT, sub: FOREIGN_ADMIN });
      for (const [method, path, body] of [
        ['POST', S(id, '/questions'), { text: 'x' }],
        ['POST', S(id, '/notes'), { body: 'x' }],
        ['POST', S(id, '/questions/generate'), {}],
      ] as const) {
        const r = await call(method, path, foreign, body);
        expect([r.status, codeOf(r.body)], path).toEqual([404, 'NOT_FOUND']);
      }
      const readOnly = await jwt({ scopes: ['screening:read'] });
      const r = await call('POST', S(id, '/notes'), readOnly, { body: 'x' });
      expect([r.status, codeOf(r.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    });

    it('A1-4/A1-5: meeting + transcript routes — honest capture modes, scope gates, concealment, fail closed without Microsoft', async () => {
      const MEETING = ['communication:meeting:create'];
      const token = await jwt({ scopes: [...ALL, ...MEETING, 'screening:transcript:read'] });
      const { id } = await draftWithFinding(token, await talent());

      // No Microsoft connection in this tenant: Teams is honestly unavailable and
      // no external capture vendor is ever presented as live (R-C).
      const modes = await call('GET', S(id, '/capture-modes'), token);
      expect(modes.status).toBe(200);
      expect(modes.body).toEqual({
        recruiter_notes: { status: 'available' },
        teams_post_meeting: { status: 'not_connected' },
        live_external_provider: { status: 'no_approved_provider' },
      });

      const slot = { subject: 'Technical screening', start_date_time: '2026-11-01T10:00:00Z', end_date_time: '2026-11-01T10:30:00Z', time_zone: 'UTC', idempotency_key: uuidv7() };
      // Both scopes are required (all-of).
      const noMeetingScope = await call('POST', S(id, '/meeting'), await jwt({ scopes: ALL }), slot);
      expect([noMeetingScope.status, codeOf(noMeetingScope.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
      // Unconfigured provider fails closed with a governed code and links nothing.
      const unconfigured = await call('POST', S(id, '/meeting'), token, slot);
      expect(unconfigured.status).toBe(409);
      expect(codeOf(unconfigured.body)).toMatch(/^MICROSOFT_/);
      const linked = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM technical_screening."ScreeningEvent" WHERE session_id = $1::uuid AND event_type = 'MEETING_LINKED'`,
        [id],
      );
      expect(linked.rows[0]!.n).toBe(0);
      const invalid = await call('POST', S(id, '/meeting'), token, { ...slot, start_date_time: 'soon' });
      expect([invalid.status, codeOf(invalid.body)]).toEqual([400, 'VALIDATION_ERROR']);

      // Transcript retrieval needs screening:transcript:read, and a linked meeting.
      const noTranscriptScope = await call('POST', S(id, '/transcripts/check'), await jwt({ scopes: ALL }));
      expect([noTranscriptScope.status, codeOf(noTranscriptScope.body)]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
      const noMeeting = await call('POST', S(id, '/transcripts/check'), token);
      expect([noMeeting.status, codeOf(noMeeting.body)]).toEqual([422, 'SCREENING_SESSION_STATE_INVALID']);

      const foreign = await jwt({ scopes: [...ALL, ...MEETING, 'screening:transcript:read'], tenant: OTHER_TENANT, sub: FOREIGN_ADMIN });
      for (const [method, path, body] of [
        ['GET', S(id, '/capture-modes'), undefined],
        ['POST', S(id, '/meeting'), slot],
        ['POST', S(id, '/transcripts/check'), undefined],
      ] as const) {
        const r = await call(method, path, foreign, body);
        expect([r.status, codeOf(r.body)], path).toEqual([404, 'NOT_FOUND']);
      }
    });
  },
);
