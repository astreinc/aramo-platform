import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../../../../apps/api/src/app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import {
  applyTalentRecordMigrations,
  seedTalentRecord,
} from './talent-record-fixtures.js';

// M5 PR-4 §4.11 — EngagementController integration spec.
//
// Boots AppModule via NestJS Test against a Postgres 17 testcontainer
// with the full migration set, signs a recruiter JWT, and exercises
// the 4 HTTP endpoints end-to-end at the wire level (HTTP →
// JwtAuthGuard → @AuthContext + class-validator → EngagementController
// → EngagementRepository → Postgres → response).
//
// Scope per directive §4.11:
//   POST /v1/selections:
//     - happy: 201 + engagement row + initial event row persisted.
//     - Pattern C refusal (no overlay): 422 SELECTION_REFERENCE_NOT_FOUND.
//   POST /v1/selections/{id}/transitions:
//     - happy: 200 + state column updated + event row appended.
//     - illegal transition: 422 SELECTION_STATE_INVALID + no state
//       change + no event row added (atomicity check).
//   GET /v1/selections/{id}:
//     - happy + cross-tenant 404.
//   GET /v1/selections/{id}/events:
//     - happy with seeded events + cross-tenant 404.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const CONSENT_MIGRATION = resolve(ROOT, 'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql');
const CONSENT_REKEY = resolve(ROOT, 'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql');
const INGESTION_INIT = resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql');
const INGESTION_SURFACE = resolve(ROOT, 'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql');
const EXAM_INIT = resolve(ROOT, 'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql');
const EXAM_LIVE_LIST = resolve(ROOT, 'libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql');
const JOB_DOMAIN_INIT = resolve(ROOT, 'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql');
// T1-a — the ATS requisition schema (Pattern-A validation now reads it).
const REQUISITION_INIT = resolve(ROOT, 'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql');
const TALENT_INIT = resolve(ROOT, 'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql');
const TALENT_EVIDENCE_INIT = resolve(ROOT, 'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql');
const TALENT_EVIDENCE_TR7 = resolve(ROOT, 'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql');
const EVIDENCE_INIT = resolve(ROOT, 'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql');
const SUBMITTAL_INIT = resolve(ROOT, 'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql');
const SUBMITTAL_REVOKE = resolve(ROOT, 'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql');
const ENGAGEMENT_INIT = resolve(ROOT, 'libs/selection/prisma/migrations/20260525120000_init_engagement_model/migration.sql');
const ENGAGEMENT_EVENT_LOG = resolve(ROOT, 'libs/selection/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql');
// M6 PR-2 §3 — engagement + submittal OutboxEvent migrations required
// because state-transition write methods now emit an in-tx outbox row.
const ENGAGEMENT_OUTBOX = resolve(ROOT, 'libs/selection/prisma/migrations/20260531000000_add_outbox_event/migration.sql');
// T2-P2 — relocate + rename the engagement objects into the selection schema.
const ENGAGEMENT_T2P2 = resolve(ROOT, 'libs/selection/prisma/migrations/20260813120000_t2p2_relocate_engagement_to_selection/migration.sql');
const SUBMITTAL_OUTBOX = resolve(ROOT, 'libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql');
// T2-P1 — relocate Submittal persistence to the submittal schema (existence-guarded; safe on this subset).
const SUBMITTAL_T2P1 = resolve(ROOT, 'libs/submittal/prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql');
// PR-A1c §4 — metering schema required (in-tx UsageEvent INSERT).
const METERING_INIT = resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql');

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-engagement-controller-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EngagementController — HTTP integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterJwt: string;
    // §18-E token-transition proof (T2-P3): three additional tokens minted
    // from the SAME signing key exercise the scope-flip recovery boundary.
    let oldEngagementJwt: string; // pre-flip: carries engagement:* (no selection:read)
    let expiredSelectionJwt: string; // post-flip scope but EXPIRED (deterministic fixture)
    let freshSelectionJwt: string; // post-refresh: carries selection:* (as the catalog re-derives)
    let setupClient: Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();
      for (const p of [
        CONSENT_MIGRATION,
        CONSENT_REKEY,
        INGESTION_INIT,
        INGESTION_SURFACE,
        EXAM_INIT,
        EXAM_LIVE_LIST,
        JOB_DOMAIN_INIT,
        REQUISITION_INIT,
        TALENT_INIT,
        TALENT_EVIDENCE_INIT,
        TALENT_EVIDENCE_TR7,
        EVIDENCE_INIT,
        SUBMITTAL_INIT,
        SUBMITTAL_REVOKE,
        SUBMITTAL_OUTBOX,
        SUBMITTAL_T2P1,
        ENGAGEMENT_INIT,
        ENGAGEMENT_EVENT_LOG,
        ENGAGEMENT_OUTBOX,
        ENGAGEMENT_T2P2,
        METERING_INIT,
        resolve(ROOT, 'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql'),
      ]) {
        const sql = readFileSync(p, 'utf8');
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.query(trimmed);
        }
      }

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for the forged tenant_id.
      // Every request (incl. the Pattern-C refusal, which uses a ghost talent under
      // TENANT_A) forges TENANT_A, so the handler's 422 is reached, not write-frozen.
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_A);

      // 4e-engagement-key — TalentRecord substrate (engagement.talent_id).
      // TENANT_A only; TENANT_B has no TalentRecord → Pattern C refusal 422.
      await applyTalentRecordMigrations(setupClient);
      await seedTalentRecord(setupClient, { id: TALENT_A, tenant_id: TENANT_A });

      // Seed Talent + overlay (TENANT_A only — TENANT_B has no overlay for
      // Pattern C refusal test).
      await setupClient.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at)
         VALUES ($1, 'active', NOW())`,
        [TALENT_A],
      );
      await setupClient.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW())`,
        ['00000000-0000-7fff-8fff-000000000001', TALENT_A, TENANT_A],
      );

      // Seed Job + Requisition (TENANT_A).
      await setupClient.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [JOB_ID, TENANT_A],
      );
      await setupClient.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status)
         VALUES ($1, $2, $3::text, $4, 'open'::requisition."RecruitingStatus")`,
        [REQ_A, TENANT_A, JOB_ID, RECRUITER_A],
      );

      // JWT setup.
      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      recruiterJwt = await new SignJWT({
        sub: RECRUITER_A,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        // R7 BE-prereq: engagement endpoints now scope-gated +
        // D4b-composed. requisition:read:all bypasses the D4b
        // visibility check so the happy-path tests proceed (the
        // D4b-narrowing proofs live in their own dedicated spec).
        scopes: ['selection:read', 'selection:write', 'selection:outreach', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      // ---- §18-E token-transition fixtures (T2-P3) --------------------
      // Same signing key / issuer / audience as recruiterJwt so all four
      // tokens are guard-valid on signature; only scopes and expiry vary.
      // requisition:read:all is carried on every token so the D4b
      // visibility check never masks the scope-boundary result.
      const nowSec = Math.floor(Date.now() / 1000);

      // (steps 1-2) OLD token: the pre-flip principal — engagement:* only.
      oldEngagementJwt = await new SignJWT({
        sub: RECRUITER_A,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        scopes: ['engagement:read', 'engagement:write', 'engagement:outreach', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      // (steps 3-4) EXPIRED token: correct post-flip scopes but past-dated
      // — the 15-minute access-TTL lapse modelled deterministically (no wait).
      expiredSelectionJwt = await new SignJWT({
        sub: RECRUITER_A,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        scopes: ['selection:read', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt(nowSec - 3600)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(nowSec - 1800)
        .sign(privateKey);

      // (steps 7-8) FRESH token: what the refresh path re-mints after
      // re-deriving scopes from the flipped catalog (recruiter → selection:*).
      freshSelectionJwt = await new SignJWT({
        sub: RECRUITER_A,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        scopes: ['selection:read', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await setupClient?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('POST /v1/selections happy: 201 + engagement + event rows persisted', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { engagement: { id: string; state: string } };
      expect(body.engagement.state).toBe('surfaced');
      // Verify event row exists.
      const evRows = await setupClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM selection."TalentSelectionEvent" WHERE engagement_id = $1::uuid`,
        [body.engagement.id],
      );
      expect(Number(evRows.rows[0]?.count ?? 0)).toBe(1);
    });

    it('POST /v1/selections Pattern C refusal: 422 when no overlay for tenant', async () => {
      // Sign a JWT for TENANT_B (no overlay for TALENT_A).
      const kp = await generateKeyPair(ALG);
      const tenantBPublic = await exportSPKI(kp.publicKey as never);
      // Use the existing audience setup, but a different tenant_id in
      // the JWT claims — the AuthModule public key was set at module
      // bootstrap; we can't swap it here, so use the existing recruiter
      // JWT and just attempt cross-tenant via a different talent. Use
      // a non-existent talent_id to force Pattern C null overlay.
      const ghostTalent = '99999999-9999-7999-8999-999999999999';
      void tenantBPublic;
      const res = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: ghostTalent, requisition_id: REQ_A }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('SELECTION_REFERENCE_NOT_FOUND');
    });

    it('POST /v1/selections/{id}/transitions happy: surfaced → evaluated', async () => {
      // First create an engagement.
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const engagementId = createBody.engagement.id;

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/selections/${engagementId}/transitions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'evaluated', event_id: randomUUID() }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { engagement: { state: string } };
      expect(body.engagement.state).toBe('evaluated');
    });

    it('POST /v1/selections/{id}/transitions illegal: 422 + no state change', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const engagementId = createBody.engagement.id;

      const evCountBefore = await setupClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM selection."TalentSelectionEvent" WHERE engagement_id = $1::uuid`,
        [engagementId],
      );
      const before = Number(evCountBefore.rows[0]?.count ?? 0);

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/selections/${engagementId}/transitions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'submitted', event_id: randomUUID() }),
        },
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('SELECTION_STATE_INVALID');

      // Atomicity: event row count unchanged.
      const evCountAfter = await setupClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM selection."TalentSelectionEvent" WHERE engagement_id = $1::uuid`,
        [engagementId],
      );
      expect(Number(evCountAfter.rows[0]?.count ?? 0)).toBe(before);
    });

    it('GET /v1/selections/{id}: 200 happy + 404 unknown', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      const createBody = (await createRes.json()) as { engagement: { id: string } };

      const hit = await fetch(
        `http://127.0.0.1:${port}/v1/selections/${createBody.engagement.id}`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(hit.status).toBe(200);

      const miss = await fetch(
        `http://127.0.0.1:${port}/v1/selections/99999999-9999-7999-8999-999999999999`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(miss.status).toBe(404);
    });

    it('GET /v1/selections/{id}/events: 200 with at least the initial event + 404 unknown engagement', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/selections`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      const createBody = (await createRes.json()) as { engagement: { id: string } };

      const hit = await fetch(
        `http://127.0.0.1:${port}/v1/selections/${createBody.engagement.id}/events`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(hit.status).toBe(200);
      const body = (await hit.json()) as { events: unknown[] };
      expect(body.events.length).toBeGreaterThanOrEqual(1);

      const miss = await fetch(
        `http://127.0.0.1:${port}/v1/selections/99999999-9999-7999-8999-999999999999/events`,
        { headers: { Authorization: `Bearer ${recruiterJwt}` } },
      );
      expect(miss.status).toBe(404);
    });

    // -----------------------------------------------------------------
    // §18-E — token-transition recovery boundary (T2-P3)
    //
    // The full 8-step recovery spans two services + the FE client. This
    // spec proves the apps/api-observable boundary + recovery (steps 1-4,
    // 7-8) deterministically against real Postgres + the real JwtAuthGuard
    // / @RequireScopes('selection:read') on GET /v1/selections. The two
    // steps that live outside apps/api are covered by existing tests and
    // are cited in the Gate-5 proof, not re-implemented here:
    //   step 5 (401 → client refresh + retry):
    //     libs/fe-foundation/src/api/client.spec.ts
    //     'a 401 triggers POST /refresh, then retries ...'
    //   step 6 (refresh re-derives scopes from the catalog):
    //     apps/auth-service/src/tests/refresh-orchestrator.service.spec.ts
    //     'orchestrates normal refresh: re-derive scopes, rotate, sign, audit'
    //   The catalog that step 6 reads now grants recruiter → selection:*
    //     (libs/identity/prisma/seed.ts), which is why the freshSelectionJwt
    //     below is the token a real refresh re-mints.
    // -----------------------------------------------------------------
    describe('§18-E token-transition recovery boundary', () => {
      const listUrl = () => `http://127.0.0.1:${port}/v1/selections`;

      it('steps 1-2: a pre-flip engagement:* token is refused 403 by the selection:* route', async () => {
        const res = await fetch(listUrl(), {
          headers: { Authorization: `Bearer ${oldEngagementJwt}` },
        });
        // The token is signature-valid and unexpired; the ONLY thing it
        // lacks is selection:read → @RequireScopes denies with 403.
        expect(res.status).toBe(403);
      });

      it('steps 3-4: an expired (post-flip-scoped) token yields 401 on a protected request', async () => {
        const res = await fetch(listUrl(), {
          headers: { Authorization: `Bearer ${expiredSelectionJwt}` },
        });
        // Correct scopes, but the 15-minute access TTL has lapsed →
        // signature verify rejects the exp claim → 401 (the refresh trigger).
        expect(res.status).toBe(401);
      });

      it('steps 7-8: the refresh-re-minted selection:* token is accepted 200 on retry', async () => {
        const res = await fetch(listUrl(), {
          headers: { Authorization: `Bearer ${freshSelectionJwt}` },
        });
        // The token a real refresh re-mints from the flipped catalog
        // carries selection:read → the retried request succeeds.
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(Array.isArray(body.items)).toBe(true);
      });
    });
  },
);
