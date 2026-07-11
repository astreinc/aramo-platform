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
import { AramoError } from '@aramo/common';

import { AppModule } from '../app.module.js';

import {
  applyTalentRecordMigrations,
  seedTalentRecord,
} from './talent-record-fixtures.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// M5 PR-6 §4.16 — POST /v1/engagements/{id}/outreach HTTP integration spec.
//
// Boots AppModule via NestJS Test against a Postgres 17 testcontainer
// with the full migration set (now including ai-draft event log),
// overrides DRAFT_PROVIDER_TOKEN + DELIVERY_PROVIDER_TOKEN with canned
// mocks, signs a recruiter JWT, and exercises the outreach endpoint
// end-to-end at the wire level.
//
// Coverage per directive §4.16 (10 integration cases):
//   - happy path (engaged → awaiting_response + 2 events + AiDraftEvent rows)
//   - pre-transaction failure semantics (AI failure → state unchanged + no events)
//   - rate-limit remap
//   - illegal state (non-engaged)
//   - NOT_FOUND
//   - INSUFFICIENT_PERMISSIONS (portal JWT)
//   - tenant isolation (cross-tenant 404)
//   - idempotency replay
//   - idempotency conflict
//   - outreach_sent payload conformance (8 fields)

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
  M('libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql'),
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
const AUDIENCE = 'aramo-outreach-send-integration';
const ALG = 'RS256';

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

const PROVIDER_RESULT_DEFAULT = {
  completion: 'Mocked outreach draft for integration test.',
  model_used: 'claude-sonnet-mock',
  input_tokens: 10,
  output_tokens: 20,
  provider_request_id: 'mock-provider-request-id',
};

const DELIVERY_RESULT_DEFAULT = {
  delivered: true as const,
  delivered_at: new Date('2026-05-25T10:01:00.000Z'),
  delivery_id: '00000000-0000-7000-8000-dddd0d000099',
  delivery_channel: 'email' as const,
};

interface MutableProvider {
  next:
    | { kind: 'value' }
    | { kind: 'throw'; error: Error };
}

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
  'POST /v1/engagements/{id}/outreach/draft + /send — HTTP integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterJwt: string;
    let portalJwt: string;
    let setup: Client;

    const mutableDraftProvider: MutableProvider = { next: { kind: 'value' } };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        const sql = readFileSync(p, 'utf8');
        for (const stmt of splitDdl(sql)) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.query(t);
        }
      }

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for each forged tenant_id.
      await ensureWriteFreezeTenant((s) => setup.query(s), TENANT_A);
      // 4e-engagement-key — engagement.talent_id now references TalentRecord.
      await applyTalentRecordMigrations(setup);

      // Seed Talent + overlay (TENANT_A only).
      await setup.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at) VALUES ($1, 'active', NOW())`,
        [TALENT_A],
      );
      await setup.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW())`,
        ['00000000-0000-7fff-8fff-000000000080', TALENT_A, TENANT_A],
      );
      // 4e-engagement-key — the TalentRecord the create validator resolves
      // (id == engagement.talent_id, tenant-scoped).
      await seedTalentRecord(setup, { id: TALENT_A, tenant_id: TENANT_A });
      // Seed Job + Requisition (TENANT_A).
      await setup.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [JOB_ID, TENANT_A],
      );
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [REQ_A, TENANT_A, JOB_ID, RECRUITER_A],
      );
      // M5 PR-9b — Step 5.5 runtime consent-at-send check requires the
      // FULL SCOPE_DEPENDENCY_CHAIN granted for TALENT_A (profile_storage
      // → matching → contacting). Granting only contacting would throw
      // 422 INVALID_SCOPE_COMBINATION from the resolver. Seeded once in
      // beforeAll because the per-test TRUNCATE below does not clear
      // consent."TalentConsentEvent".
      for (const [n, scope] of [
        ['80', 'profile_storage'],
        ['81', 'matching'],
        ['82', 'contacting'],
      ] as const) {
        await setup.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2, $3, $4, 'granted', $5,
                   'recruiter_capture', 'v1', NOW(), NOW())`,
          [
            `00000000-0000-7000-8000-ffff0c0000${n}`,
            TALENT_A,
            TENANT_A,
            scope,
            RECRUITER_A,
          ],
        );
      }

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
        // visibility check so the happy-path tests proceed.
        scopes: ['engagement:read', 'engagement:write', 'engagement:outreach', 'requisition:read:all'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      portalJwt = await new SignJWT({
        sub: TALENT_A,
        consumer_type: 'portal',
        actor_kind: 'user',
        tenant_id: TENANT_A,
        scopes: [],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      const mockDraftProvider = {
        generate: async (): Promise<typeof PROVIDER_RESULT_DEFAULT> => {
          const nx = mutableDraftProvider.next;
          if (nx.kind === 'throw') {
            // Reset to default after one throw — each test arranges
            // explicitly when it wants a failure.
            mutableDraftProvider.next = { kind: 'value' };
            throw nx.error;
          }
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
      // Reset draft provider behavior so prior test's failure-arrangement
      // doesn't leak forward.
      mutableDraftProvider.next = { kind: 'value' };
      // Reset engagement + event tables between tests; AI-draft event
      // rows accumulate harmlessly across tests.
      await setup.query('TRUNCATE TABLE engagement."TalentEngagementEvent" CASCADE');
      await setup.query('TRUNCATE TABLE engagement."TalentJobEngagement" CASCADE');
      await setup.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
    });

    async function createAndAdvanceToEngaged(): Promise<string> {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/engagements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const id = createBody.engagement.id;
      const transition = async (to_state: string): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state, event_id: randomUUID() }),
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

    async function readEngagementState(engagementId: string): Promise<string> {
      const r = await setup.query<{ state: string }>(
        `SELECT state::text AS state FROM engagement."TalentJobEngagement" WHERE id = $1::uuid`,
        [engagementId],
      );
      return r.rows[0]?.state ?? '';
    }

    // Outreach Draft/Preview split helpers.
    function draftOutreach(
      id: string,
      opts: { key?: string; prompt?: string; max_tokens?: number } = {},
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/outreach/draft`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': opts.key ?? randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: opts.prompt ?? 'Reach out to talent.',
          ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
        }),
      });
    }

    function sendOutreach(
      id: string,
      draftEventId: string,
      opts: { key?: string; final_text?: string; jwt?: string } = {},
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/outreach/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.jwt ?? recruiterJwt}`,
          'Idempotency-Key': opts.key ?? randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          draft_event_id: draftEventId,
          final_text: opts.final_text ?? 'Reach out to talent.',
        }),
      });
    }

    async function draftAndGetId(id: string): Promise<string> {
      const r = await draftOutreach(id);
      expect(r.status).toBe(200);
      const b = (await r.json()) as { draft_event_id: string };
      return b.draft_event_id;
    }

    it('happy path: DRAFT (no delivery) then SEND → awaiting_response + 3 total events + AiDraftEvent rows', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const eventsBefore = await countEvents(id);

      // DRAFT — persists ONE outreach_drafted event, NO delivery, state stays engaged.
      const draftRes = await draftOutreach(id, { max_tokens: 256 });
      expect(draftRes.status).toBe(200);
      const draft = (await draftRes.json()) as {
        draft_event_id: string;
        draft_text: string;
        ai_draft_audit_record_id: string;
      };
      expect(draft.draft_event_id).toBeTruthy();
      expect(draft.draft_text).toBeTruthy();
      expect(await readEngagementState(id)).toBe('engaged');
      expect((await countEvents(id)) - eventsBefore).toBe(1); // outreach_drafted only

      // SEND — delivers, transitions to awaiting_response, +2 events.
      const sendRes = await sendOutreach(id, draft.draft_event_id, { final_text: 'Edited final.' });
      expect(sendRes.status).toBe(200);
      const body = (await sendRes.json()) as {
        engagement: { state: string };
        outreach_event: { event_type: string };
        delivery_id: string;
      };
      expect(body.engagement.state).toBe('awaiting_response');
      expect(body.outreach_event.event_type).toBe('outreach_sent');
      expect(body.delivery_id).toBeTruthy();
      // Total events: 1 (drafted) + 2 (sent + transition) = 3.
      expect((await countEvents(id)) - eventsBefore).toBe(3);

      const aiCount = await setup.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ai_draft."AiDraftEvent" WHERE tenant_id = $1::uuid`,
        [TENANT_A],
      );
      expect(Number(aiCount.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(3);
    });

    it('DRAFT no-delivery / no-transition proof: drafting leaves state engaged + appends only outreach_drafted + emits no outbox', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const eventsBefore = await countEvents(id);
      // Outbox rows for this engagement already exist from the setup
      // transitions (create→evaluated→engaged each emit a state_transition
      // outbox row). DRAFT must add NONE.
      const outboxForEngagement = async (): Promise<number> => {
        const r = await setup.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM engagement."OutboxEvent"
           WHERE event_payload->>'engagement_id' = $1`,
          [id],
        );
        return Number(r.rows[0]?.count ?? 0);
      };
      const outboxBefore = await outboxForEngagement();

      const draftRes = await draftOutreach(id);
      expect(draftRes.status).toBe(200);
      // No delivery, no state transition — generation only.
      expect(await readEngagementState(id)).toBe('engaged');
      // Exactly one new event, and it is an outreach_drafted (no
      // outreach_sent, no state_transition).
      expect((await countEvents(id)) - eventsBefore).toBe(1);
      const evt = await setup.query<{ event_type: string }>(
        `SELECT event_type::text AS event_type FROM engagement."TalentEngagementEvent"
         WHERE engagement_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      expect(evt.rows[0]?.event_type).toBe('outreach_drafted');
      // Drafting emitted NO new outbox row.
      expect(await outboxForEngagement()).toBe(outboxBefore);
    });

    it('multi-draft: two DRAFT calls append two outreach_drafted rows; SEND from either succeeds', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draft1 = await draftAndGetId(id);
      const draft2 = await draftAndGetId(id);
      expect(draft1).not.toBe(draft2);
      const drafted = await setup.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM engagement."TalentEngagementEvent"
         WHERE engagement_id = $1::uuid AND event_type = 'outreach_drafted'`,
        [id],
      );
      expect(Number(drafted.rows[0]?.count ?? 0)).toBe(2);
      // SEND from the second draft succeeds.
      const sendRes = await sendOutreach(id, draft2);
      expect(sendRes.status).toBe(200);
    });

    it('DRAFT: AI throws provider_unavailable → 502; no draft persisted', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const eventsBefore = await countEvents(id);
      mutableDraftProvider.next = {
        kind: 'throw',
        error: new AramoError('INTERNAL_ERROR', 'connection refused', 502, {
          requestId: 'mock',
          details: { kind: 'provider_unavailable' },
        }),
      };
      const res = await draftOutreach(id);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('AI_PROVIDER_UNAVAILABLE');
      // No draft event appended.
      expect(await countEvents(id)).toBe(eventsBefore);
    });

    it('DRAFT: AI throws provider_rate_limited → 429 AI_RATE_LIMITED', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      mutableDraftProvider.next = {
        kind: 'throw',
        error: new AramoError('INTERNAL_ERROR', 'rate limited', 429, {
          requestId: 'mock',
          details: { kind: 'provider_rate_limited' },
        }),
      };
      const res = await draftOutreach(id);
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('AI_RATE_LIMITED');
    });

    it('DRAFT illegal state: 422 ENGAGEMENT_STATE_INVALID when engagement in surfaced state (gated to engaged)', { timeout: 60_000 }, async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/engagements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_A, requisition_id: REQ_A }),
      });
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const id = createBody.engagement.id;

      const res = await draftOutreach(id);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('ENGAGEMENT_STATE_INVALID');
    });

    it('SEND: ENGAGEMENT_REFERENCE_NOT_FOUND 422 when draft_event_id is unknown', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const res = await sendOutreach(id, '99999999-9999-7999-8999-999999999999');
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
    });

    it('DRAFT NOT_FOUND 404 when engagement does not exist', { timeout: 30_000 }, async () => {
      const res = await draftOutreach('99999999-9999-7999-8999-999999999999');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('INSUFFICIENT_PERMISSIONS 403 with portal JWT (both draft + send)', { timeout: 30_000 }, async () => {
      const draftRes = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/00000000-0000-7000-8000-000000000aaa/outreach/draft`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portalJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Reach out to talent.' }),
        },
      );
      expect(draftRes.status).toBe(403);
      expect(((await draftRes.json()) as { error: { code: string } }).error?.code).toBe(
        'INSUFFICIENT_PERMISSIONS',
      );

      const sendRes = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/00000000-0000-7000-8000-000000000aaa/outreach/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portalJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            draft_event_id: '00000000-0000-7000-8000-000000000bbb',
            final_text: 'x',
          }),
        },
      );
      expect(sendRes.status).toBe(403);
      expect(((await sendRes.json()) as { error: { code: string } }).error?.code).toBe(
        'INSUFFICIENT_PERMISSIONS',
      );
    });

    it('single-send: a second SEND of the same draft 422s (state already awaiting_response — no double-send)', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draftEventId = await draftAndGetId(id);
      const first = await sendOutreach(id, draftEventId);
      expect(first.status).toBe(200);
      // Second send (new idempotency key) finds state awaiting_response → 422.
      const second = await sendOutreach(id, draftEventId);
      expect(second.status).toBe(422);
      expect(((await second.json()) as { error: { code: string } }).error?.code).toBe(
        'ENGAGEMENT_STATE_INVALID',
      );
    });

    it('SEND idempotency replay: same key + same body returns identical response', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draftEventId = await draftAndGetId(id);
      const key = randomUUID();
      const first = await sendOutreach(id, draftEventId, { key, final_text: 'Final text.' });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const second = await sendOutreach(id, draftEventId, { key, final_text: 'Final text.' });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);
    });

    it('SEND idempotency conflict: same key + different body → 409 IDEMPOTENCY_KEY_CONFLICT', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draftEventId = await draftAndGetId(id);
      const key = randomUUID();
      const first = await sendOutreach(id, draftEventId, { key, final_text: 'Text A.' });
      expect(first.status).toBe(200);
      const second = await sendOutreach(id, draftEventId, { key, final_text: 'DIFFERENT text B.' });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: { code: string } }).error?.code).toBe(
        'IDEMPOTENCY_KEY_CONFLICT',
      );
    });

    it('outreach_sent payload conforms to OutreachSentPayload (10 fields incl final_text + source_draft_event_id)', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draftEventId = await draftAndGetId(id);
      const res = await sendOutreach(id, draftEventId, { final_text: 'The approved final text.' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        outreach_event: { event_payload: Record<string, unknown> };
      };
      const payload = body.outreach_event.event_payload;
      expect(typeof payload['ai_draft_audit_record_id']).toBe('string');
      expect(typeof payload['model_used']).toBe('string');
      expect(typeof payload['input_tokens']).toBe('number');
      expect(typeof payload['output_tokens']).toBe('number');
      expect(typeof payload['duration_ms']).toBe('number');
      expect(typeof payload['delivered_at']).toBe('string');
      expect(payload['delivery_channel']).toBe('email');
      expect(typeof payload['delivery_id']).toBe('string');
      // The editable-trail additions.
      expect(payload['final_text']).toBe('The approved final text.');
      expect(payload['source_draft_event_id']).toBe(draftEventId);
      expect(Object.keys(payload)).toHaveLength(10);
    });

    it('editable trail: final_text differs from the AI draft_text; both persist + are linked', { timeout: 60_000 }, async () => {
      const id = await createAndAdvanceToEngaged();
      const draftRes = await draftOutreach(id);
      expect(draftRes.status).toBe(200);
      const draft = (await draftRes.json()) as { draft_event_id: string; draft_text: string };
      const edited = `EDITED: ${draft.draft_text} (recruiter changes)`;
      const sendRes = await sendOutreach(id, draft.draft_event_id, { final_text: edited });
      expect(sendRes.status).toBe(200);
      // The drafted text persists on the outreach_drafted event...
      const draftedRow = await setup.query<{ event_payload: Record<string, unknown> }>(
        `SELECT event_payload FROM engagement."TalentEngagementEvent" WHERE id = $1::uuid`,
        [draft.draft_event_id],
      );
      const draftedPayload = draftedRow.rows[0]?.event_payload as Record<string, unknown>;
      expect(draftedPayload['draft_text']).toBe(draft.draft_text);
      // ...and the final (edited) text persists on the outreach_sent event,
      // linked back to the draft. drafted_text !== final_text is provable.
      const sentRow = await setup.query<{ event_payload: Record<string, unknown> }>(
        `SELECT event_payload FROM engagement."TalentEngagementEvent"
         WHERE engagement_id = $1::uuid AND event_type = 'outreach_sent' LIMIT 1`,
        [id],
      );
      const sentPayload = sentRow.rows[0]?.event_payload as Record<string, unknown>;
      expect(sentPayload['final_text']).toBe(edited);
      expect(sentPayload['final_text']).not.toBe(draft.draft_text);
      expect(sentPayload['source_draft_event_id']).toBe(draft.draft_event_id);
    });
  },
);
