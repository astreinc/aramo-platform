import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { establishOpenRequisition } from './support/establish-open-requisition.js';
import { ConfigurableTestResolver } from './support/test-auth-harness.js';

// ATS-QA-1 D1/D2 — GET /v1/talent-360/:id surfaces the pipeline milestones
// (Activity type `pipeline_status_change`, subject_type 'pipeline', subject_id =
// the episode id — exactly what PipelineRepository writes) for the Talent's
// episodes ON REQUISITIONS THE VIEWER MAY SEE, each carrying its episode's
// requisition_id (so Talent × Requisition 360 can scope it). Real Postgres 17 +
// the full AppModule (real guards + visibility interceptor). Skipped unless
// ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
};
const MIGRATION_FILES: string[] = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('metering'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('consent'),
  ...migrationsFor('company'),
  ...migrationsFor('contact'),
  ...migrationsFor('requisition'),
  ...migrationsFor('talent-record'),
  ...migrationsFor('activity'),
  ...migrationsFor('calendar'),
  ...migrationsFor('saved-list'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('submittal'),
  ...migrationsFor('client-selection'),
  ...migrationsFor('placement'),
  // The Talent Journey composer descends into pre-start requirements for a
  // STARTED placement (Level 3b) — its table must exist.
  ...migrationsFor('pre-start-requirement'),
  ...migrationsFor('task'),
  ...migrationsFor('submittal-eligibility'),
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
  // Talent 360 additionally composes across communications (last contact).
  ...migrationsFor('communications'),
  // Boot-only: the CI reconciler's onModuleInit scan needs its table present.
  ...migrationsFor('conversation-intelligence'),
];

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (!inDollar && ch === "'") {
      inString = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-talent-360-milestones-integration-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const ADMIN = '00000000-0000-7000-8000-000000000aa1';

const FULL_SCOPES = [
  'talent:read',
  'pipeline:read',
  'task:read',
  'activity:read',
  'communication:read',
  'document:read',
];
const DAY = 86_400_000;
const __resolver = new ConfigurableTestResolver();

type SignKey = CryptoKey | KeyObject;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'GET /v1/talent-360/:id — pipeline milestones on visible requisitions (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let key: SignKey;

    let talent = '';
    let reqVisible = '';
    let reqHidden = '';
    let reqVisibleNumber = 0;
    let pVisible = '';
    let pHidden = '';
    const NOW = Date.now();
    const QUALIFIED_ACT = randomUUID();
    const CONTACTED_ACT = randomUUID();
    const HIDDEN_ACT = randomUUID();

    async function jwt(scopes: readonly string[], tenant = TENANT_A, sub = RECRUITER): Promise<string> {
      return new SignJWT({
        sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        authz_version: __resolver.grant(tenant, sub, [...scopes]),
        site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function get(talentId: string, token: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/talent-360/${talentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    }

    async function seedPipeline(req: string, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [id, TENANT_A, talent, req, status],
      );
      return id;
    }
    // Mirrors PipelineRepository's activity write (transition step 4c).
    async function seedMilestone(id: string, pipelineId: string, notes: string, whenMs: number) {
      await db.query(
        `INSERT INTO activity."Activity" (id, tenant_id, site_id, type, subject_type, subject_id, notes, created_by_id, created_at)
         VALUES ($1,$2,$3,'pipeline_status_change'::"activity"."ActivityType",'pipeline',$4,$5,$6,$7)`,
        [id, TENANT_A, SITE_A, pipelineId, notes, ADMIN, new Date(whenMs)],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATION_FILES) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          const t = s.trim();
          if (t) await db.query(t);
        }
      }
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_A],
      );

      const kp = await generateKeyPair(ALG);
      key = kp.privateKey;
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__resolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      // ---- seed ----
      const company = randomUUID();
      await db.query(`INSERT INTO company."Company" (id, tenant_id, site_id, name) VALUES ($1,$2,$3,$4)`, [company, TENANT_A, SITE_A, 'Freddie Mac']);
      talent = randomUUID();
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, site_id, first_name, last_name, email1, source, record_status, created_at, updated_at)
         VALUES ($1,$2,$3,'Divya','Vasudevan','divya@example.com','Referral sourcing','live',now(),now())`,
        [talent, TENANT_A, SITE_A],
      );
      const mkReq = async (title: string) =>
        establishOpenRequisition(app, { tenant_id: TENANT_A, entered_by_id: ADMIN, input: { title, company_id: company, site_id: SITE_A } });
      const visible = await mkReq('Scrum Master — Multifamily');
      reqVisible = visible.id;
      reqHidden = (await mkReq('Salesforce Admin (unassigned)')).id;
      const n = await db.query(`SELECT requisition_number FROM requisition."Requisition" WHERE id = $1`, [reqVisible]);
      reqVisibleNumber = Number(n.rows[0].requisition_number);
      // reqHidden intentionally unassigned → visibility-hidden for RECRUITER.
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment" (id, tenant_id, requisition_id, user_id, assigned_at, assigned_by_id) VALUES ($1,$2,$3,$4,now(),$5)`,
        [randomUUID(), TENANT_A, reqVisible, RECRUITER, ADMIN],
      );

      pVisible = await seedPipeline(reqVisible, 'qualified');
      pHidden = await seedPipeline(reqHidden, 'qualified');
      // Historical event: written when the episode left No contact — the episode is
      // now Qualified, but the event must keep its ORIGINAL stage keys.
      await seedMilestone(CONTACTED_ACT, pVisible, 'pipeline no_contact -> contacted', NOW - 3 * DAY);
      await seedMilestone(QUALIFIED_ACT, pVisible, 'pipeline qualifying -> qualified: Strong screen', NOW - DAY);
      await seedMilestone(HIDDEN_ACT, pHidden, 'pipeline qualifying -> qualified', NOW - DAY);
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });

    it('(a) the Qualified milestone appears in the Talent activity, carrying its requisition_id', async () => {
      const { status, body } = await get(talent, await jwt(FULL_SCOPES));
      expect(status).toBe(200);
      const item = (body.recent_activity.items as any[]).find((i) => i.id === `activity:${QUALIFIED_ACT}`);
      expect(item).toBeDefined();
      expect(item.requisition_id).toBe(reqVisible);
      expect(item.requisition_label).toBe(`REQ-${reqVisibleNumber}`);
      expect(item.title).toBe('Stage changed');
      expect(item.category).toBe('requisitions');
      expect(item.body).toBe('pipeline qualifying -> qualified: Strong screen');
      // TR360 scopes the feed by requisition_id — the milestone is in that requisition's feed.
      const reqFeed = (body.recent_activity.items as any[]).filter((i) => i.requisition_id === reqVisible);
      expect(reqFeed.map((i) => i.id)).toContain(`activity:${QUALIFIED_ACT}`);
    });

    it('(b) a milestone on a requisition the viewer cannot see is NOT returned (negative)', async () => {
      const { body } = await get(talent, await jwt(FULL_SCOPES));
      const items = body.recent_activity.items as any[];
      expect(items.some((i) => i.id === `activity:${HIDDEN_ACT}`)).toBe(false);
      expect(items.some((i) => i.requisition_id === reqHidden)).toBe(false);
      expect(JSON.stringify(body)).not.toContain(pHidden);
    });

    it('(c) historical events keep their original stage keys', async () => {
      const { body } = await get(talent, await jwt(FULL_SCOPES));
      const item = (body.recent_activity.items as any[]).find((i) => i.id === `activity:${CONTACTED_ACT}`);
      expect(item).toBeDefined();
      expect(item.body).toBe('pipeline no_contact -> contacted');
      expect(item.requisition_id).toBe(reqVisible);
    });

    it('without pipeline:read no milestone is composed (no broadening)', async () => {
      const { status, body } = await get(talent, await jwt(['talent:read', 'activity:read']));
      expect(status).toBe(200);
      const items = body.recent_activity.items as any[];
      expect(items.some((i) => i.id.startsWith('activity:') && i.requisition_id !== null)).toBe(false);
    });
  },
);
