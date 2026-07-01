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

import { AppModule } from '../app.module.js';

import {
  applyTalentRecordMigrations,
  seedTalentRecord,
} from './talent-record-fixtures.js';

// M5 PR-4 §4.10 — negative-shape integration test for POST
// /v1/engagements/{id}/transitions. F23 standing pattern.
//
// Note: this spec exercises a state-transition response which carries
// the `outreach_sent` event-type vocabulary in event payloads — covered
// by scripts/verify-vocabulary.sh TIER2_EXCLUDES + eslint.config.mjs
// no-restricted-syntax exemption per M5 PR-4 §4.13.

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
  // because the happy-path assertion(s) reach the state-transition method
  // which now emits an in-tx outbox row.
  M('libs/engagement/prisma/migrations/20260531000000_add_outbox_event/migration.sql'),
  M('libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql'),
  // PR-A1c §4 — metering schema required (in-tx UsageEvent INSERT).
  M('libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-engagement-transition-neg-shape';
const ALG = 'RS256';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

const FORBIDDEN_MATCH_CLASS_KEYS: ReadonlyArray<string> = [
  'tier', 'rank', 'rank_ordinal', 'score', 'internal_reasoning',
  'why_matched_sentence', 'strengths', 'gaps', 'risk_flags',
  'recruiter_notes', 'override_id', 'action_queue_item_id',
  'internal_engagement_state',
];

function walk(node: unknown, path: string, hits: Array<{ path: string; key: string }>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, hits);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_MATCH_CLASS_KEYS.includes(k)) hits.push({ path: `${path}.${k}`, key: k });
    walk(v, `${path}.${k}`, hits);
  }
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
  'POST /v1/engagements/{id}/transitions — negative-shape (no Match-Class vocabulary leak)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterJwt: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new Client({ connectionString: url });
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
      await seedTalentRecord(setup, { id: TALENT_ID, tenant_id: TENANT_ID });
      await setup.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at) VALUES ($1, 'active', NOW())`,
        [TALENT_ID],
      );
      await setup.query(
        `INSERT INTO talent."TalentTenantOverlay" (id, talent_id, tenant_id, source_channel, tenant_status, updated_at)
         VALUES ($1, $2, $3, 'self_signup', 'active', NOW())`,
        ['00000000-0000-7fff-8fff-000000000020', TALENT_ID, TENANT_ID],
      );
      await setup.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [JOB_ID, TENANT_ID],
      );
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [REQ_ID, TENANT_ID, JOB_ID, RECRUITER_ID],
      );
      await setup.end();

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
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        // R7 BE-prereq: engagement endpoints now scope-gated.
        // requisition:read:all bypasses D4b visibility.
        scopes: ['engagement:read', 'engagement:write', 'engagement:outreach', 'requisition:read:all'],
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
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('200 engagement-transition response contains no Match-Class vocabulary keys anywhere', async () => {
      // Create an engagement first.
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/engagements`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { engagement: { id: string } };
      const engagementId = createBody.engagement.id;

      // Transition surfaced → evaluated.
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/engagements/${engagementId}/transitions`,
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
      const body = (await res.json()) as unknown;
      const hits: Array<{ path: string; key: string }> = [];
      walk(body, '$', hits);
      expect(
        hits,
        `Match-Class vocabulary leaked into POST /v1/engagements/{id}/transitions response: ${hits.map((h) => h.path).join(', ')}`,
      ).toEqual([]);
    });
  },
);
