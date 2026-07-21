import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RequisitionPrismaService,
  RequisitionRepository,
} from '@aramo/requisition';
import {
  IndeedJobSyncConnector,
  IndeedTokenService,
  JobDistributionPostingStateRepository,
  JobDistributionPrismaService,
  INDEED_CLIENT_ID_ENV,
  INDEED_CLIENT_SECRET_ENV,
} from '@aramo/job-distribution';

import { JobDistributionSyncService } from '../job-distribution/job-distribution-sync.service.js';

// SRC-2 PR-3 (R4) — the freshness sweep, full lifecycle against real Postgres.
// Real: RequisitionRepository (publishable read), JobDistributionPostingStateRepository
// (ChannelPostingState transitions), IndeedTokenService + IndeedJobSyncConnector
// (real fetch code). Faked: the Indeed endpoint — global `fetch` is stubbed to
// answer the OAuth token POST and the two GraphQL mutations with RECON-1-shaped
// fixtures. NO live Indeed call anywhere.

const ROOT = resolve(__dirname, '../../../..');

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition'), ...migrationsFor('job-distribution')];

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < noLineComments.length; i++) {
    if (noLineComments.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = noLineComments[i];
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// The faked Indeed endpoint (RECON-1 fixture responses). Records mutation calls;
// `failCreateOnce` drives the ERROR→retry path.
interface FakeIndeed {
  creates: unknown[];
  expires: unknown[];
  failCreateOnce: boolean;
  counter: number;
}

function installFakeFetch(fake: FakeIndeed): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const ok = (body: unknown): Response =>
        ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;

      if (u.includes('/oauth/')) {
        return ok({ access_token: 'tok', expires_in: 3600 });
      }
      const parsed = JSON.parse((init?.body as string) ?? '{}') as {
        query: string;
        variables?: {
          input?: { jobPostings?: Array<{ metadata?: { jobPostingId?: string } }> };
        };
      };
      if (parsed.query.includes('createSourcedJobPostings')) {
        fake.creates.push(parsed);
        if (fake.failCreateOnce) {
          fake.failCreateOnce = false;
          return ok({ errors: [{ message: 'transient' }] });
        }
        // Idempotency (RECON-1): the SAME (jobPostingId, sourceName) always maps to
        // the SAME sourcedPostingId — echoed on create AND every subsequent upsert.
        const jobPostingId =
          parsed.variables?.input?.jobPostings?.[0]?.metadata?.jobPostingId ?? 'x';
        return ok({
          data: {
            jobsIngest: {
              createSourcedJobPostings: {
                results: [{ jobPosting: { sourcedPostingId: `SRC-${jobPostingId}` } }],
              },
            },
          },
        });
      }
      if (parsed.query.includes('expireSourcedJobsBySourcedPostingId')) {
        fake.expires.push(parsed);
        return ok({ data: { jobsIngest: { expireSourcedJobsBySourcedPostingId: { results: [] } } } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  );
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SRC-2 PR-3 — Indeed Job Sync freshness sweep (real Postgres)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let service: JobDistributionSyncService;
    let postingStates: JobDistributionPostingStateRepository;
    const fake: FakeIndeed = { creates: [], expires: [], failCreateOnce: false, counter: 0 };
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17-alpine').start();
      const uri = container.getConnectionUri();
      db = new Client({ connectionString: uri });
      await db.connect();
      for (const file of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(file, 'utf8'))) {
          await db.query(stmt);
        }
      }

      savedEnv[INDEED_CLIENT_ID_ENV] = process.env[INDEED_CLIENT_ID_ENV];
      savedEnv[INDEED_CLIENT_SECRET_ENV] = process.env[INDEED_CLIENT_SECRET_ENV];
      savedEnv['ARAMO_INDEED_APPLY_WEBHOOK_SECRET'] = process.env['ARAMO_INDEED_APPLY_WEBHOOK_SECRET'];
      process.env[INDEED_CLIENT_ID_ENV] = 'client-abc';
      process.env[INDEED_CLIENT_SECRET_ENV] = 'secret-xyz';
      process.env['ARAMO_INDEED_APPLY_WEBHOOK_SECRET'] = 'apply-secret';

      const reqPrisma = new RequisitionPrismaService(uri);
      const jdPrisma = new JobDistributionPrismaService(uri);
      await reqPrisma.$connect();
      await jdPrisma.$connect();
      postingStates = new JobDistributionPostingStateRepository(jdPrisma);
      const tokens = new IndeedTokenService();
      const connector = new IndeedJobSyncConnector(tokens);
      const noop = (): undefined => undefined;
      const logger = { log: noop, warn: noop, error: noop, debug: noop };
      service = new JobDistributionSyncService(
        new RequisitionRepository(reqPrisma) as never,
        postingStates as never,
        connector as never,
        tokens as never,
        logger as never,
      );
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    // Per-test isolation: the sweep is GLOBAL (listEnabledConfigs returns every
    // enabled tenant), so each test starts from a clean slate to avoid cross-test
    // bleed. Fake state resets too.
    beforeEach(async () => {
      await db.query('TRUNCATE requisition."Requisition" CASCADE');
      await db.query('TRUNCATE job_distribution."TenantChannelConfig" CASCADE');
      await db.query('TRUNCATE job_distribution."ChannelPostingState" CASCADE');
      fake.creates = [];
      fake.expires = [];
      fake.failCreateOnce = false;
      fake.counter = 0;
      installFakeFetch(fake);
    });

    afterEach(() => vi.restoreAllMocks());

    async function seedRequisition(tenantId: string, reqId: string, title: string): Promise<void> {
      await db.query(
        `INSERT INTO requisition."Requisition"
          (id, tenant_id, title, company_id, status, openings, public_listing,
           advertised_pay_min, advertised_pay_max, advertised_pay_period, advertised_pay_currency,
           city, state, job_type, work_arrangement, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::requisition."RequisitionStatus",2,true,
           80.00,120.00,$6::requisition."RatePeriod",'USD',
           'Austin','TX','FULL_TIME','REMOTE', now(), now())`,
        [reqId, tenantId, title, '99999999-9999-4999-8999-999999999999', 'active', 'HOURLY'],
      );
    }

    async function seedConfig(tenantId: string, enabled: boolean): Promise<void> {
      await db.query(
        `INSERT INTO job_distribution."TenantChannelConfig" (id, tenant_id, channel, enabled, config)
         VALUES (gen_random_uuid(), $1, 'indeed', $2, $3::jsonb)`,
        [
          tenantId,
          enabled,
          JSON.stringify({
            employer_ids: [{ type: 'INDEED', id: 'emp-1' }],
            apply_host: 'acme.aramo.ai',
            company_name: 'Acme',
          }),
        ],
      );
    }

    async function stateOf(tenantId: string, reqId: string) {
      const r = await db.query(
        `SELECT sync_status, external_posting_id, tombstoned_at
           FROM job_distribution."ChannelPostingState"
          WHERE tenant_id=$1 AND requisition_id=$2 AND channel='indeed'`,
        [tenantId, reqId],
      );
      return r.rows[0] as
        | { sync_status: string; external_posting_id: string | null; tombstoned_at: Date | null }
        | undefined;
    }

    it('full lifecycle: create → update → expire against real posting-state', async () => {
      const tenant = '11111111-1111-7111-8111-1111111111a1';
      const req = '22222222-2222-7222-8222-2222222222a1';
      await seedConfig(tenant, true);
      await seedRequisition(tenant, req, 'Staff Engineer');

      // CREATE
      const r1 = await service.tick();
      expect(r1.created).toBe(1);
      let st = await stateOf(tenant, req);
      expect(st?.sync_status).toBe('LIVE');
      expect(st?.external_posting_id).toBe(`SRC-${req}`);
      const createdId = st?.external_posting_id;

      // NOOP on an unchanged second tick
      const r2 = await service.tick();
      expect(r2.noop).toBe(1);
      expect(r2.created).toBe(0);

      // UPDATE after a content change (title) — SAME external id (upsert idempotency)
      await db.query(`UPDATE requisition."Requisition" SET title=$2 WHERE id=$1`, [req, 'Principal Engineer']);
      const r3 = await service.tick();
      expect(r3.updated).toBe(1);
      st = await stateOf(tenant, req);
      expect(st?.sync_status).toBe('LIVE');
      expect(st?.external_posting_id).toBe(createdId);

      // EXPIRE after it leaves the publishable set (unpublished)
      await db.query(`UPDATE requisition."Requisition" SET public_listing=false WHERE id=$1`, [req]);
      const r4 = await service.tick();
      expect(r4.expired).toBe(1);
      st = await stateOf(tenant, req);
      expect(st?.sync_status).toBe('EXPIRED');
      expect(st?.tombstoned_at).not.toBeNull();
      expect(fake.expires.length).toBeGreaterThanOrEqual(1);
    });

    it('a disabled tenant is untouched', async () => {
      const tenant = '11111111-1111-7111-8111-1111111111a2';
      const req = '22222222-2222-7222-8222-2222222222a2';
      await seedConfig(tenant, false);
      await seedRequisition(tenant, req, 'Ignored');
      await service.tick();
      expect(await stateOf(tenant, req)).toBeUndefined();
    });

    it('credentials unset → the whole tick is skipped', async () => {
      const saved = process.env[INDEED_CLIENT_ID_ENV];
      delete process.env[INDEED_CLIENT_ID_ENV];
      const tenant = '11111111-1111-7111-8111-1111111111a3';
      const req = '22222222-2222-7222-8222-2222222222a3';
      await seedConfig(tenant, true);
      await seedRequisition(tenant, req, 'Skipped');
      const result = await service.tick();
      expect(result.skipped).toBe(true);
      expect(await stateOf(tenant, req)).toBeUndefined();
      if (saved === undefined) delete process.env[INDEED_CLIENT_ID_ENV];
      else process.env[INDEED_CLIENT_ID_ENV] = saved;
    });

    it('ERROR then recovers on the next tick (re-enterable)', async () => {
      fake.failCreateOnce = true;
      const tenant = '11111111-1111-7111-8111-1111111111a4';
      const req = '22222222-2222-7222-8222-2222222222a4';
      await seedConfig(tenant, true);
      await seedRequisition(tenant, req, 'Retry Me');

      const r1 = await service.tick();
      expect(r1.errors).toBe(1);
      let st = await stateOf(tenant, req);
      expect(st?.sync_status).toBe('ERROR');

      const r2 = await service.tick();
      st = await stateOf(tenant, req);
      expect(st?.sync_status).toBe('LIVE');
      expect(st?.external_posting_id).not.toBeNull();
      expect(r2.created + r2.updated).toBeGreaterThanOrEqual(1);
    });
  },
);
