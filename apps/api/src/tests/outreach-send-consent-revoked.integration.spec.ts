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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

import {
  applyTalentRecordMigrations,
  seedTalentRecord,
} from './talent-record-fixtures.js';

// M5 PR-9b §4.6 / Ruling 10 — POST /v1/engagements/{id}/outreach
// consent-at-send refusal integration spec. Plan v1.5 §M5 Track B item 3
// closure: "Consent enforcement at message send time (not just engagement
// creation)."
//
// Tests Step 5.5 (added at PR-9b) of EngagementController.sendOutreach:
// the controller pre-reads the engagement, calls ConsentService.check
// with operation='engagement' + channel='email', and refuses 403
// CONSENT_NOT_GRANTED_AT_SEND when the resolver returns 'denied'.
//
// Coverage (5 tests per directive §4.6 deliverable enumeration):
//   1. revoked-at-send refusal — grant then revoke; outreach-send → 403.
//   2. never-granted refusal — engagement created without prior grant.
//   3. tenant isolation — revoke in tenant A doesn't affect tenant B's
//      separately-granted outreach.
//   4. idempotency replay stability — repeat refusal with same key + body.
//   5. AI draft NOT consumed when denied — assert draft provider's
//      generate() was never called on a denied path.
//
// Note: stale-consent refusal (per directive §4.6 test 3) is NOT covered
// here because the resolver's staleness window is calendar-based; a unit
// test of the resolver gates the staleness path. The integration test
// here focuses on the revoked + never-granted paths which are the
// state-driven refusal classes most relevant to the Plan v1.5 verbatim
// "message send time" enforcement intent.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  M('libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql'),
  M('libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql'),
  M('libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql'),
  M('libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql'),
  M('libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql'),
  M('libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql'),
  M('libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql'),
  M('libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql'),
  M('libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql'),
  M('libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql'),
  M('libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql'),
  M('libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql'),
  M('libs/engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql'),
  M('libs/engagement/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql'),
  // M6 PR-2 §3 — engagement + submittal OutboxEvent migrations required
  // because state-transition write methods now emit an in-tx outbox row.
  M('libs/engagement/prisma/migrations/20260531000000_add_outbox_event/migration.sql'),
  // Outreach Draft/Preview Amendment v1.1 §3 — the outreach_drafted enum value.
  M('libs/engagement/prisma/migrations/20260609000000_add_outreach_drafted_event_type/migration.sql'),
  M('libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql'),
  M('libs/ai-draft/prisma/migrations/20260525170000_init/migration.sql'),
  // PR-A1c §4 — metering schema required (in-tx UsageEvent INSERT).
  M('libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-outreach-send-consent-revoked-integration';
const ALG = 'RS256';

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_B = '00000000-0000-7000-8000-000000000bb2';
const JOB_ID_A = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const JOB_ID_B = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeee02';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const REQ_B = 'cccccccc-cccc-7ccc-8ccc-cccccccccc02';

const PROVIDER_RESULT_DEFAULT = {
  completion: 'Mocked outreach draft for consent-revoked integration test.',
  model_used: 'claude-sonnet-mock',
  input_tokens: 10,
  output_tokens: 20,
  provider_request_id: 'mock-provider-request-id',
};

const DELIVERY_RESULT_DEFAULT = {
  delivered: true as const,
  delivered_at: new Date('2026-05-27T10:01:00.000Z'),
  delivery_id: '00000000-0000-7000-8000-dddd0d000099',
  delivery_channel: 'email' as const,
};

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
    } else current += ch;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'POST /v1/engagements/{id}/outreach/send — consent-at-send refusal integration (Outreach Draft/Preview; relocated from atomic /outreach)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterAJwt: string;
    let recruiterBJwt: string;
    let setup: Client;

    // Records every call to the draft provider's generate() so the
    // AI-draft-NOT-consumed test can assert zero invocations on the
    // denied path.
    const draftProviderCalls: { count: number } = { count: 0 };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.query(t);
        }
      }
      // 4e-engagement-key — TalentRecord substrate (engagement.talent_id).
      await applyTalentRecordMigrations(setup);
      await seedTalentRecord(setup, { id: TALENT_A, tenant_id: TENANT_A });
      await seedTalentRecord(setup, { id: TALENT_B, tenant_id: TENANT_B });

      // Seed Talents + overlays for two tenants (TENANT_A + TENANT_B).
      await setup.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at)
         VALUES ($1, 'active', NOW()), ($2, 'active', NOW())`,
        [TALENT_A, TALENT_B],
      );
      await setup.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW()),
                ($4, $5, $6, 'self_signup', 'active', NOW())`,
        [
          '00000000-0000-7fff-8fff-0000000000a1', TALENT_A, TENANT_A,
          '00000000-0000-7fff-8fff-0000000000a2', TALENT_B, TENANT_B,
        ],
      );
      await setup.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [JOB_ID_A, TENANT_A, JOB_ID_B, TENANT_B],
      );
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState"),
                ($5, $6, $7, $8, 'active'::job_domain."RequisitionState")`,
        [
          REQ_A, TENANT_A, JOB_ID_A, RECRUITER_A,
          REQ_B, TENANT_B, JOB_ID_B, RECRUITER_B,
        ],
      );

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

      recruiterAJwt = await new SignJWT({
        sub: RECRUITER_A,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        // R7 BE-prereq: engagement endpoints now scope-gated +
        // D4b-composed. requisition:read:all bypasses the D4b
        // visibility check so the happy-path tests proceed.
        scopes: ['engagement:read', 'engagement:write', 'engagement:outreach', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      recruiterBJwt = await new SignJWT({
        sub: RECRUITER_B,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_B,
        // R7 BE-prereq: engagement endpoints now scope-gated +
        // D4b-composed. requisition:read:all bypasses the D4b
        // visibility check so the happy-path tests proceed.
        scopes: ['engagement:read', 'engagement:write', 'engagement:outreach', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      const mockDraftProvider = {
        generate: async (): Promise<typeof PROVIDER_RESULT_DEFAULT> => {
          draftProviderCalls.count += 1;
          return PROVIDER_RESULT_DEFAULT;
        },
      };
      const mockDeliveryProvider = {
        deliver: async (): Promise<typeof DELIVERY_RESULT_DEFAULT> => {
          return DELIVERY_RESULT_DEFAULT;
        },
      };

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider('DRAFT_PROVIDER_TOKEN')
        .useValue(mockDraftProvider)
        .overrideProvider('DELIVERY_PROVIDER_TOKEN')
        .useValue(mockDeliveryProvider)
        .compile();

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
      await setup?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      draftProviderCalls.count = 0;
      // Each test arranges its own consent state; clear engagement +
      // event + idempotency + consent tables between tests so prior
      // state doesn't leak.
      await setup.query('TRUNCATE TABLE engagement."TalentEngagementEvent" CASCADE');
      await setup.query('TRUNCATE TABLE engagement."TalentJobEngagement" CASCADE');
      await setup.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
      await setup.query('TRUNCATE TABLE consent."TalentConsentEvent" CASCADE');
    });

    // Seeds the full SCOPE_DEPENDENCY_CHAIN (profile_storage + matching
    // + contacting) granted. The resolver enforces the chain at check
    // time — granting only contacting would fire 422
    // INVALID_SCOPE_COMBINATION instead of the 403 refusal we test for.
    async function seedContactingGrant(
      talentId: string,
      tenantId: string,
      recruiterId: string,
      occurredAt: Date = new Date(),
    ): Promise<void> {
      for (const scope of ['profile_storage', 'matching', 'contacting']) {
        await setup.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, 'granted', $5,
                   'recruiter_capture', 'v1', $6, NOW())`,
          [randomUUID(), talentId, tenantId, scope, recruiterId, occurredAt],
        );
      }
    }

    // Seeds only the prerequisite chain (profile_storage + matching);
    // contacting intentionally absent so the resolver returns
    // result='denied' with reason_code reflecting the missing/unknown
    // contacting state — driving the 403 CONSENT_NOT_GRANTED_AT_SEND
    // refusal at Step 5.5 without triggering the 422 dep-unmet path.
    async function seedPrerequisiteChainOnly(
      talentId: string,
      tenantId: string,
      recruiterId: string,
      occurredAt: Date = new Date(),
    ): Promise<void> {
      for (const scope of ['profile_storage', 'matching']) {
        await setup.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, 'granted', $5,
                   'recruiter_capture', 'v1', $6, NOW())`,
          [randomUUID(), talentId, tenantId, scope, recruiterId, occurredAt],
        );
      }
    }

    async function seedContactingRevoke(
      talentId: string,
      tenantId: string,
      recruiterId: string,
      occurredAt: Date = new Date(),
    ): Promise<void> {
      await setup.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
            captured_method, consent_version, occurred_at, created_at)
         VALUES ($1, $2, $3, 'contacting', 'revoked', $4,
                 'recruiter_capture', 'v1', $5, NOW())`,
        [randomUUID(), talentId, tenantId, recruiterId, occurredAt],
      );
    }

    async function createEngagementAdvanceToEngaged(
      jwt: string,
      talentId: string,
      reqId: string,
    ): Promise<string> {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/engagements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: talentId, requisition_id: reqId }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const id = createBody.engagement.id;
      const transition = async (to: string): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: to, event_id: randomUUID() }),
        });
        expect(r.status).toBe(200);
      };
      await transition('evaluated');
      await transition('engaged');
      return id;
    }

    async function countEvents(engagementId: string): Promise<number> {
      const r = await setup.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM engagement."TalentEngagementEvent"
         WHERE engagement_id = $1::uuid`,
        [engagementId],
      );
      return Number(r.rows[0]?.count ?? 0);
    }

    // Outreach Draft/Preview split — DRAFT half. Under the split, drafting
    // is NEVER blocked by consent (it warns, non-blocking). Returns the
    // raw Response + the parsed body so callers can assert status +
    // consent_warning + extract draft_event_id.
    async function draftOutreach(
      jwt: string,
      id: string,
    ): Promise<{ status: number; body: { draft_event_id?: string; consent_warning?: unknown } }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/outreach/draft`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'Reach out.', max_tokens: 256 }),
      });
      const body = (await res.json()) as { draft_event_id?: string; consent_warning?: unknown };
      return { status: res.status, body };
    }

    // Outreach Draft/Preview split — SEND half. The BINDING consent gate.
    function sendOutreach(
      jwt: string,
      id: string,
      draftEventId: string,
      key: string = randomUUID(),
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/outreach/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ draft_event_id: draftEventId, final_text: 'Reach out.' }),
      });
    }

    it('revoked-at-send: DRAFT succeeds (consent does NOT block at draft) but SEND → 403 + no new events', { timeout: 60_000 }, async () => {
      // Grant first so the engagement can be created.
      await seedContactingGrant(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      // Now revoke — BEFORE the outreach attempt.
      await seedContactingRevoke(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-04-01T00:00:00.000Z'));

      // The relocation made explicit: DRAFT is NOT blocked by consent —
      // it succeeds (200) and surfaces a non-blocking consent_warning.
      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);
      expect(draft.body.draft_event_id).toBeDefined();
      expect(draft.body.consent_warning).toBeDefined();

      // Count AFTER drafting (the draft persisted an outreach_drafted event).
      const eventsBefore = await countEvents(id);

      // The BINDING gate fires at SEND.
      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; details: { consent_decision: { result: string }; engagement_id: string } } };
      expect(body.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
      expect(body.error.details.consent_decision.result).toBe('denied');
      expect(body.error.details.engagement_id).toBe(id);

      // No new outreach_sent / state_transition events written; the
      // refusal short-circuits BEFORE delivery + the atomic write.
      const eventsAfter = await countEvents(id);
      expect(eventsAfter).toBe(eventsBefore);
    });

    it('TR-2a-B3a superseded-record send-gate: DRAFT ok, SEND → 422 TALENT_RECORD_SUPERSEDED (before consent), no new events', { timeout: 60_000 }, async () => {
      // Directive §5(b) — the send-gate treats a superseded record as
      // non-operational. Seed a FRESH live record, create+engage against it while
      // live, grant contacting (so consent would PASS — proving the refusal is the
      // supersession gate at Step 5.5, not the consent gate at Step 8), THEN
      // supersede it (the state the B3b reconcile writer will produce — seeded
      // directly here, writer-less slice), THEN send.
      const supersededTalent = '0a0a0a0a-0a0a-7a0a-8a0a-0a0a0a0a0a0a';
      const survivorTalent = '0b0b0b0b-0b0b-7b0b-8b0b-0b0b0b0b0b0b';
      await setup.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, 'Superseded', 'Husk', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET record_status = 'live', superseded_by_record_id = NULL, superseded_at = NULL`,
        [supersededTalent, TENANT_A],
      );
      await seedContactingGrant(supersededTalent, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, supersededTalent, REQ_A);

      // Supersede the record AFTER the engagement exists (a late merge retired it).
      await setup.query(
        `UPDATE talent_record."TalentRecord"
           SET record_status = 'superseded', superseded_by_record_id = $2::uuid, superseded_at = NOW()
         WHERE id = $1::uuid`,
        [supersededTalent, survivorTalent],
      );

      // DRAFT is not gated (non-blocking) — it still produces a draft event.
      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);
      expect(draft.body.draft_event_id).toBeDefined();
      const eventsBefore = await countEvents(id);

      // SEND refuses with the supersession gate — 422, survivor pointer surfaced.
      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        error: { code: string; details: { superseded_by_record_id: string; engagement_id: string } };
      };
      expect(body.error.code).toBe('TALENT_RECORD_SUPERSEDED');
      expect(body.error.details.superseded_by_record_id).toBe(survivorTalent);
      expect(body.error.details.engagement_id).toBe(id);

      // No delivery, no new events — the refusal short-circuits before the write.
      const eventsAfter = await countEvents(id);
      expect(eventsAfter).toBe(eventsBefore);

      // Clean up so the stray record does not perturb other tests' tenant reads.
      await setup.query(`DELETE FROM talent_record."TalentRecord" WHERE id = $1::uuid`, [supersededTalent]);
    });

    it('contacting-never-granted (prerequisites only): DRAFT ok, SEND → 403 CONSENT_NOT_GRANTED_AT_SEND', { timeout: 60_000 }, async () => {
      // Realistic production scenario: profile_storage + matching are
      // granted (talent is searchable + has been matched), but
      // contacting has never been granted. The dependency chain check
      // passes; the requested-scope check fails → resolver returns
      // result='denied' → the binding consent-at-send check converts to
      // 403 CONSENT_NOT_GRANTED_AT_SEND.
      await seedPrerequisiteChainOnly(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);

      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);

      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
    });

    // ───────────────────────────────────────────────────────────────────
    // STEP-4 (consent re-key) MANDATORY ACCEPTANCE GATE — the distinct-id
    // grant→send round-trip. 4e could NOT prove this (there, the engagement's
    // TalentRecord.id and the Core id were one shared UUID). The consent re-key
    // is what makes the ledger TalentRecord-keyed, so this is the test that
    // proves the axis keys on TalentRecord.id — NOT the Core id.
    // CORE_DISTINCT is a Core-style id deliberately ≠ the engagement's
    // TalentRecord.id (TALENT_A).
    // ───────────────────────────────────────────────────────────────────
    const CORE_DISTINCT = '9c9c9c9c-9c9c-7c9c-8c9c-9c9c9c9c9c9c';

    it('STEP-4(a): consent granted under the engagement TalentRecord.id IS found by the send-gate → 200', { timeout: 60_000 }, async () => {
      expect(CORE_DISTINCT).not.toBe(TALENT_A);
      // Full chain keyed to TALENT_A — the engagement's talent_id IS a
      // TalentRecord.id (post-#349) and consent is now TalentRecord-keyed.
      await seedContactingGrant(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);
      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(200);
    });

    it('STEP-4(b): consent granted under a Core id DISTINCT from the TalentRecord.id is NOT found → 403', { timeout: 60_000 }, async () => {
      // Full contacting chain granted under CORE_DISTINCT (≠ the engagement's
      // TalentRecord.id); prerequisites granted under TALENT_A so the resolver
      // reaches the contacting decision for TALENT_A rather than 422-ing on a
      // missing dependency.
      await seedContactingGrant(CORE_DISTINCT, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      await seedPrerequisiteChainOnly(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);
      // The gate queries consent by TALENT_A (the TalentRecord.id); the
      // contacting grant under CORE_DISTINCT is invisible → denied → 403.
      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
    });

    it('tenant isolation: revoke in tenant A does not affect tenant B', { timeout: 60_000 }, async () => {
      // Tenant A — revoked.
      await seedContactingGrant(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const idA = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      await seedContactingRevoke(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-04-01T00:00:00.000Z'));
      // Tenant B — independently granted.
      await seedContactingGrant(TALENT_B, TENANT_B, RECRUITER_B, new Date('2026-01-01T00:00:00.000Z'));
      const idB = await createEngagementAdvanceToEngaged(recruiterBJwt, TALENT_B, REQ_B);

      const draftA = await draftOutreach(recruiterAJwt, idA);
      expect(draftA.status).toBe(200);
      const resA = await sendOutreach(recruiterAJwt, idA, draftA.body.draft_event_id as string);
      expect(resA.status).toBe(403);

      const draftB = await draftOutreach(recruiterBJwt, idB);
      expect(draftB.status).toBe(200);
      const resB = await sendOutreach(recruiterBJwt, idB, draftB.body.draft_event_id as string);
      expect(resB.status).toBe(200);
    });

    it('idempotency replay stability: same SEND key + same body returns 403 again (stable refusal)', { timeout: 60_000 }, async () => {
      await seedContactingGrant(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      await seedContactingRevoke(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-04-01T00:00:00.000Z'));

      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);
      const draftEventId = draft.body.draft_event_id as string;
      const key = randomUUID();

      const first = await sendOutreach(recruiterAJwt, id, draftEventId, key);
      expect(first.status).toBe(403);

      // Retry with the same key + body — the idempotency record was NOT
      // persisted (the binding consent check throws before the persist),
      // so the second call re-evaluates the consent state freshly. The
      // revoke is still in effect, so the refusal is stable: 403 again.
      const second = await sendOutreach(recruiterAJwt, id, draftEventId, key);
      expect(second.status).toBe(403);
      const secondBody = (await second.json()) as { error: { code: string } };
      expect(secondBody.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
    });

    it('SEND consumes NO AI draft (generation is at DRAFT; consent-denied send delivers nothing)', { timeout: 60_000 }, async () => {
      await seedContactingGrant(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-01-01T00:00:00.000Z'));
      const id = await createEngagementAdvanceToEngaged(recruiterAJwt, TALENT_A, REQ_A);
      await seedContactingRevoke(TALENT_A, TENANT_A, RECRUITER_A, new Date('2026-04-01T00:00:00.000Z'));

      // Draft first (this DOES consume one AI call — consent is a warning
      // at draft, not a block).
      const draft = await draftOutreach(recruiterAJwt, id);
      expect(draft.status).toBe(200);

      // Reset the counter AFTER drafting so we measure only the SEND call.
      draftProviderCalls.count = 0;
      const res = await sendOutreach(recruiterAJwt, id, draft.body.draft_event_id as string);
      expect(res.status).toBe(403);
      // SEND never calls the AI provider — generation already happened.
      expect(draftProviderCalls.count).toBe(0);
    });
  },
);
