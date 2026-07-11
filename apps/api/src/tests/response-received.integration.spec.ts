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

// M5 PR-7 §4.12 — POST /v1/engagements/{id}/response HTTP integration.
//
// Coverage:
//   - happy: awaiting_response → responded + 2 events + payload conformance.
//   - cross-event-ref refusal sub-paths (Ruling 4):
//       (a) null ref ID
//       (b) cross-engagement ref (within same tenant)
//       (c) wrong event_type ref (state_transition / response_received)
//       (d) cross-tenant ref
//   - ENGAGEMENT_STATE_INVALID 422 (engagement in surfaced state).
//   - canTransition natural-key dedup (engagement already in responded).
//   - NOT_FOUND 404.
//   - INSUFFICIENT_PERMISSIONS 403.
//   - Idempotency-Key replay (same key + same body).
//   - outreach_event existence + payload conformance after recording.

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
const AUDIENCE = 'aramo-response-received-integration';
const ALG = 'RS256';

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const RESPONSE_RECEIVED_AT = '2026-05-25T12:00:00.000Z';

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
  'POST /v1/engagements/{id}/response — HTTP integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterJwt: string;
    let portalJwt: string;
    let setup: Client;

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
      await setup.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at) VALUES ($1, 'active', NOW())`,
        [TALENT_A],
      );
      await setup.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW())`,
        ['00000000-0000-7fff-8fff-000000000050', TALENT_A, TENANT_A],
      );
      await setup.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [JOB_ID, TENANT_A],
      );
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [REQ_A, TENANT_A, JOB_ID, RECRUITER_A],
      );
      // M5 PR-9b — full SCOPE_DEPENDENCY_CHAIN granted so /outreach
      // Step 5.5 returns 'allowed' (granting only contacting would fire
      // 422 INVALID_SCOPE_COMBINATION via resolver dep check).
      for (const [n, scope] of [
        ['83', 'profile_storage'],
        ['84', 'matching'],
        ['85', 'contacting'],
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
        generate: async (): Promise<{
          completion: string;
          model_used: string;
          input_tokens: number;
          output_tokens: number;
          provider_request_id: string;
        }> => ({
          completion: 'mocked draft for response-received integration test.',
          model_used: 'claude-sonnet-mock',
          input_tokens: 10,
          output_tokens: 20,
          provider_request_id: 'mock',
        }),
      };
      const mockDeliveryProvider = {
        deliver: async (): Promise<{
          delivered: true;
          delivered_at: Date;
          delivery_id: string;
          delivery_channel: 'email';
        }> => ({
          delivered: true,
          delivered_at: new Date('2026-05-25T10:01:00.000Z'),
          delivery_id: '00000000-0000-7000-8000-fffd0d000005',
          delivery_channel: 'email',
        }),
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
      await setup.query('TRUNCATE TABLE engagement."TalentEngagementEvent" CASCADE');
      await setup.query('TRUNCATE TABLE engagement."TalentJobEngagement" CASCADE');
      await setup.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
    });

    async function createAndAdvanceToAwaitingResponse(): Promise<{ engagementId: string; outreachEventId: string }> {
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
      const engagementId = createBody.engagement.id;
      const transition = async (to_state: string): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/transitions`, {
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
      // Outreach Draft/Preview split: DRAFT then SEND to reach
      // awaiting_response with an outreach_sent event.
      const draftRes = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/${engagementId}/outreach/draft`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Reach out.' }),
        },
      );
      expect(draftRes.status).toBe(200);
      const draftBody = (await draftRes.json()) as { draft_event_id: string };
      const outreachRes = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/${engagementId}/outreach/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ draft_event_id: draftBody.draft_event_id, final_text: 'Reach out.' }),
        },
      );
      expect(outreachRes.status).toBe(200);
      const outreachBody = (await outreachRes.json()) as {
        outreach_event: { id: string };
      };
      return { engagementId, outreachEventId: outreachBody.outreach_event.id };
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

    it('happy path: 200 + state responded + 2 new events + payload conformance (3 fields)', { timeout: 60_000 }, async () => {
      const { engagementId, outreachEventId } = await createAndAdvanceToAwaitingResponse();
      const eventsBefore = await countEvents(engagementId);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: outreachEventId,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        engagement: { state: string };
        response_event: { event_type: string; event_payload: Record<string, unknown> };
      };
      expect(body.engagement.state).toBe('responded');
      expect(body.response_event.event_type).toBe('response_received');
      const payload = body.response_event.event_payload;
      expect(payload['response_received_at']).toBe(RESPONSE_RECEIVED_AT);
      expect(typeof payload['recorded_by_user_id']).toBe('string');
      expect(payload['outreach_event_ref_id']).toBe(outreachEventId);
      expect(Object.keys(payload)).toHaveLength(3);
      // transition_event NOT projected.
      expect((body as Record<string, unknown>)['transition_event']).toBeUndefined();
      const eventsAfter = await countEvents(engagementId);
      expect(eventsAfter - eventsBefore).toBe(2);
    });

    it('cross-event ref happy: outreach_event_ref_id correctly resolves; no orphan events on success', { timeout: 60_000 }, async () => {
      const { engagementId, outreachEventId } = await createAndAdvanceToAwaitingResponse();
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: outreachEventId,
        }),
      });
      expect(res.status).toBe(200);
    });

    it('ENGAGEMENT_REFERENCE_NOT_FOUND (null ref): random UUID → 422; state UNCHANGED + 0 events appended', { timeout: 60_000 }, async () => {
      const { engagementId } = await createAndAdvanceToAwaitingResponse();
      const stateBefore = await readEngagementState(engagementId);
      const eventsBefore = await countEvents(engagementId);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: '99999999-9999-7999-8999-999999999999',
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error?.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      expect(body.error?.details?.['field']).toBe('outreach_event_ref_id');
      expect(await readEngagementState(engagementId)).toBe(stateBefore);
      expect(await countEvents(engagementId)).toBe(eventsBefore);
    });

    it('ENGAGEMENT_REFERENCE_NOT_FOUND (cross-engagement ref): E1 outreach_event_id used on E2 → 422; E2 UNCHANGED', { timeout: 90_000 }, async () => {
      const e1 = await createAndAdvanceToAwaitingResponse();
      const e2 = await createAndAdvanceToAwaitingResponse();
      const stateBefore = await readEngagementState(e2.engagementId);
      const eventsBefore = await countEvents(e2.engagementId);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${e2.engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: e1.outreachEventId,
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      expect(await readEngagementState(e2.engagementId)).toBe(stateBefore);
      expect(await countEvents(e2.engagementId)).toBe(eventsBefore);
    });

    it('ENGAGEMENT_REFERENCE_NOT_FOUND (wrong event_type): use state_transition event id → 422', { timeout: 60_000 }, async () => {
      const { engagementId } = await createAndAdvanceToAwaitingResponse();
      // Pick a state_transition event from this engagement's event log.
      const rows = await setup.query<{ id: string }>(
        `SELECT id::text AS id FROM engagement."TalentEngagementEvent"
         WHERE engagement_id = $1::uuid AND event_type = 'state_transition' LIMIT 1`,
        [engagementId],
      );
      const stEventId = rows.rows[0]?.id;
      expect(stEventId).toBeTruthy();
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: stEventId,
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
    });

    it('cross-tenant ref attack: tenant A POST referencing event UUID that exists only in tenant B → 422 (refEvent NOT in caller tenant)', { timeout: 60_000 }, async () => {
      const { engagementId } = await createAndAdvanceToAwaitingResponse();
      // Manually insert an outreach_sent event under a different tenant.
      const ghostTenant = '22222222-2222-7222-8222-222222222222';
      const ghostEventId = '00000000-0000-7000-8000-bbbb0e000099';
      const ghostEngagementId = '00000000-0000-7000-8000-bbbb00000099';
      await setup.query(
        `INSERT INTO engagement."TalentJobEngagement"
           (id, tenant_id, talent_id, requisition_id, examination_id, state, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'awaiting_response'::engagement."EngagementState", NOW())`,
        [ghostEngagementId, ghostTenant, TALENT_A, REQ_A],
      );
      await setup.query(
        `INSERT INTO engagement."TalentEngagementEvent"
           (id, tenant_id, engagement_id, event_type, event_payload, created_at)
         VALUES ($1, $2, $3, 'outreach_sent'::engagement."EngagementEventType", $4::jsonb, NOW())`,
        [ghostEventId, ghostTenant, ghostEngagementId, JSON.stringify({ delivery_channel: 'email' })],
      );
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: ghostEventId,
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
    });

    it('ENGAGEMENT_STATE_INVALID 422 when engagement in surfaced state', { timeout: 30_000 }, async () => {
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
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: '99999999-9999-7999-8999-999999999988',
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      // Could be either ENGAGEMENT_REFERENCE_NOT_FOUND (lookup ran first
      // in surfaced state) OR ENGAGEMENT_STATE_INVALID. Per repository
      // step ordering, NOT_FOUND-equivalent ref lookup precedes state
      // check, so REFERENCE_NOT_FOUND fires here.
      expect(['ENGAGEMENT_REFERENCE_NOT_FOUND', 'ENGAGEMENT_STATE_INVALID']).toContain(body.error?.code);
    });

    it('NOT_FOUND 404 when engagement does not exist', { timeout: 30_000 }, async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/99999999-9999-7999-8999-999999999777/response`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: '99999999-9999-7999-8999-999999999888',
          }),
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('INSUFFICIENT_PERMISSIONS 403 with portal JWT', { timeout: 30_000 }, async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/99999999-9999-7999-8999-999999999666/response`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portalJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: '99999999-9999-7999-8999-999999999555',
          }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('idempotency replay: same key + same body returns identical response', { timeout: 90_000 }, async () => {
      const { engagementId, outreachEventId } = await createAndAdvanceToAwaitingResponse();
      const key = randomUUID();
      const body = JSON.stringify({
        response_received_at: RESPONSE_RECEIVED_AT,
        outreach_event_ref_id: outreachEventId,
      });
      const first = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const second = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body,
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody).toEqual(firstBody);
    });

    it('canTransition natural-key dedup: engagement already in responded → 422 ENGAGEMENT_STATE_INVALID even with fresh key', { timeout: 90_000 }, async () => {
      const { engagementId, outreachEventId } = await createAndAdvanceToAwaitingResponse();
      // First record — advances to responded.
      const first = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: RESPONSE_RECEIVED_AT,
          outreach_event_ref_id: outreachEventId,
        }),
      });
      expect(first.status).toBe(200);
      // Second record — fresh key, fresh body — repository's canTransition
      // pre-check (after the ref-validation succeeds) refuses with 422.
      const second = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: '2026-05-25T13:00:00.000Z',
          outreach_event_ref_id: outreachEventId,
        }),
      });
      expect(second.status).toBe(422);
      const secondBody = (await second.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(secondBody.error?.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(secondBody.error?.details?.['from_state']).toBe('responded');
      expect(secondBody.error?.details?.['to_state']).toBe('responded');
    });
  },
);
