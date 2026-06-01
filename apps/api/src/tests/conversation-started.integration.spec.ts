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

// M5 PR-8a §4.12 — POST /v1/engagements/{id}/conversation HTTP integration.
//
// Coverage (8 tests; SMALLER than PR-7's 11 because no cross-event
// reference refusal sub-paths per Ruling 3):
//   - happy: responded → in_conversation + 2 events + payload conformance
//     (2 required fields).
//   - ENGAGEMENT_STATE_INVALID 422 (engaged): seed engaged, POST → 422,
//     state UNCHANGED + 0 events.
//   - ENGAGEMENT_STATE_INVALID 422 (awaiting_response).
//   - ENGAGEMENT_STATE_INVALID 422 (in_conversation): natural-key dedup;
//     state UNCHANGED + 0 events; details.from_state='in_conversation',
//     details.to_state='in_conversation'.
//   - NOT_FOUND 404: nonexistent engagement_id.
//   - INSUFFICIENT_PERMISSIONS 403: portal JWT.
//   - Tenant isolation: cross-tenant POST → 404 NOT_FOUND.
//   - Idempotency-Key replay: same key + same body → identical response.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  M('libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql'),
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
  M('libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql'),
  M('libs/ai-draft/prisma/migrations/20260525170000_init/migration.sql'),
  // PR-A1c §4 — metering schema required (in-tx UsageEvent INSERT).
  M('libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-conversation-started-integration';
const ALG = 'RS256';

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_A = '00000000-0000-7000-8000-000000000bb1';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const CONVERSATION_STARTED_AT = '2026-05-25T12:00:00.000Z';

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
  'POST /v1/engagements/{id}/conversation — HTTP integration (real Postgres 17)',
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
      await setup.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at) VALUES ($1, 'active', NOW())`,
        [TALENT_A],
      );
      await setup.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW())`,
        ['00000000-0000-7fff-8fff-000000000070', TALENT_A, TENANT_A],
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
      // M5 PR-9b — full SCOPE_DEPENDENCY_CHAIN so /outreach Step 5.5
      // returns 'allowed' (resolver throws 422 INVALID_SCOPE_COMBINATION
      // when contacting checked without profile_storage + matching).
      for (const [n, scope] of [
        ['86', 'profile_storage'],
        ['87', 'matching'],
        ['88', 'contacting'],
      ] as const) {
        await setup.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_id, tenant_id, scope, action, captured_by_actor_id,
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
        scopes: [],
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
          completion: 'mocked draft for conversation-started integration test.',
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
          delivery_id: '00000000-0000-7000-8000-fffd0d000006',
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

    async function createAndAdvanceToResponded(): Promise<string> {
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
      const outreachRes = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/outreach`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'Reach out.' }),
      });
      expect(outreachRes.status).toBe(200);
      const outreachBody = (await outreachRes.json()) as { outreach_event: { id: string } };
      const responseRes = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_received_at: '2026-05-25T11:00:00.000Z',
          outreach_event_ref_id: outreachBody.outreach_event.id,
        }),
      });
      expect(responseRes.status).toBe(200);
      return engagementId;
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

    it('happy path: 200 + state in_conversation + 2 new events + payload conformance (2 fields)', { timeout: 90_000 }, async () => {
      const engagementId = await createAndAdvanceToResponded();
      const eventsBefore = await countEvents(engagementId);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${engagementId}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_started_at: CONVERSATION_STARTED_AT,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        engagement: { state: string };
        conversation_event: { event_type: string; event_payload: Record<string, unknown> };
      };
      expect(body.engagement.state).toBe('in_conversation');
      expect(body.conversation_event.event_type).toBe('conversation_started');
      const payload = body.conversation_event.event_payload;
      expect(payload['conversation_started_at']).toBe(CONVERSATION_STARTED_AT);
      expect(typeof payload['recorded_by_user_id']).toBe('string');
      expect(Object.keys(payload)).toHaveLength(2);
      // transition_event NOT projected.
      expect((body as Record<string, unknown>)['transition_event']).toBeUndefined();
      const eventsAfter = await countEvents(engagementId);
      expect(eventsAfter - eventsBefore).toBe(2);
    });

    it('ENGAGEMENT_STATE_INVALID 422 when engagement in engaged state; state UNCHANGED + 0 events appended', { timeout: 60_000 }, async () => {
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
      const stateBefore = await readEngagementState(id);
      const eventsBefore = await countEvents(id);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error?.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(body.error?.details?.['from_state']).toBe('engaged');
      expect(body.error?.details?.['to_state']).toBe('in_conversation');
      expect(await readEngagementState(id)).toBe(stateBefore);
      expect(await countEvents(id)).toBe(eventsBefore);
    });

    it('ENGAGEMENT_STATE_INVALID 422 when engagement in awaiting_response state; state UNCHANGED + 0 events appended', { timeout: 60_000 }, async () => {
      // Drive to awaiting_response via /outreach.
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
      const outreachRes = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/outreach`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'Reach out.' }),
      });
      expect(outreachRes.status).toBe(200);
      const stateBefore = await readEngagementState(id);
      const eventsBefore = await countEvents(id);
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error?.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(body.error?.details?.['from_state']).toBe('awaiting_response');
      expect(body.error?.details?.['to_state']).toBe('in_conversation');
      expect(await readEngagementState(id)).toBe(stateBefore);
      expect(await countEvents(id)).toBe(eventsBefore);
    });

    it('ENGAGEMENT_STATE_INVALID 422 natural-key dedup: engagement already in in_conversation → 422 with from=in_conversation,to=in_conversation', { timeout: 120_000 }, async () => {
      const id = await createAndAdvanceToResponded();
      // First conversation-started: advances to in_conversation.
      const first = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
      });
      expect(first.status).toBe(200);
      expect(await readEngagementState(id)).toBe('in_conversation');
      const stateBefore = await readEngagementState(id);
      const eventsBefore = await countEvents(id);
      // Second conversation-started — fresh key, fresh body — refused by
      // canTransition (in_conversation → in_conversation absent from
      // matrix).
      const second = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversation_started_at: '2026-05-25T13:00:00.000Z' }),
      });
      expect(second.status).toBe(422);
      const body = (await second.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error?.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(body.error?.details?.['from_state']).toBe('in_conversation');
      expect(body.error?.details?.['to_state']).toBe('in_conversation');
      expect(await readEngagementState(id)).toBe(stateBefore);
      expect(await countEvents(id)).toBe(eventsBefore);
    });

    it('NOT_FOUND 404 when engagement does not exist', { timeout: 30_000 }, async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/99999999-9999-7999-8999-999999999111/conversation`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('INSUFFICIENT_PERMISSIONS 403 with portal JWT', { timeout: 30_000 }, async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/99999999-9999-7999-8999-999999999222/conversation`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${portalJwt}`,
            'Idempotency-Key': randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('tenant isolation: engagement seeded under tenant B; tenant A POST → 404 NOT_FOUND', { timeout: 60_000 }, async () => {
      // Seed an engagement under TENANT_B in responded state (raw insert
      // bypasses cross-schema validators; this is the canonical pattern
      // used by the response-received integration's cross-tenant test).
      const ghostEngagementId = '00000000-0000-7000-8000-bbbb00000c11';
      await setup.query(
        `INSERT INTO engagement."TalentJobEngagement"
           (id, tenant_id, talent_id, requisition_id, examination_id, state, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'responded'::engagement."EngagementState", NOW())`,
        [ghostEngagementId, TENANT_B, TALENT_A, REQ_A],
      );
      // Tenant A recruiter posts at the tenant-B engagement_id — repository
      // findByTenantAndId returns null because tenant_id scope mismatches.
      const res = await fetch(`http://127.0.0.1:${port}/v1/engagements/${ghostEngagementId}/conversation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    });

    it('idempotency replay: same key + same body returns identical response', { timeout: 120_000 }, async () => {
      const id = await createAndAdvanceToResponded();
      const key = randomUUID();
      const body = JSON.stringify({ conversation_started_at: CONVERSATION_STARTED_AT });
      const first = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
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
      const second = await fetch(`http://127.0.0.1:${port}/v1/engagements/${id}/conversation`, {
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
  },
);
