import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { EngagementRepository } from '../lib/engagement.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-1 §4.9 — integration spec for libs/engagement (read-path tests).
//
// Brings up a Postgres 17 testcontainer, applies the engagement init
// migration, seeds engagements via raw SQL (PR-1 has no builder method
// — write path lands at M5 PR-3), constructs EngagementRepository, and
// asserts the 4 read methods round-trip + tenant isolation + projection
// correctness against real Postgres.
//
// Dollar-quote-aware splitter (splitDdl below) — the engagement
// migration carries a CREATE FUNCTION block with a $$ ... $$ body
// containing semicolons. A naive `.split(';')` would corrupt the
// trigger SQL; the splitter only splits on semicolons OUTSIDE
// dollar-quoted regions.

const ENGAGEMENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const REQUISITION_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const REQUISITION_B = 'cccccccc-cccc-7ccc-8ccc-ccccccccc999';
const EXAM_A = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

const ENGAGEMENT_1 = '00000000-0000-7000-8000-000000000001';
const ENGAGEMENT_2 = '00000000-0000-7000-8000-000000000002';
const ENGAGEMENT_3 = '00000000-0000-7000-8000-000000000003';
const ENGAGEMENT_TENANT_B = '00000000-0000-7000-8000-000000000004';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EngagementRepository — read-path integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: EngagementRepository;
    let setupClient: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrationSql = readFileSync(ENGAGEMENT_MIGRATION_PATH, 'utf8');

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new EngagementRepository(prisma, makeMockLogger());

      // Tenant A: three engagements for (TALENT_A, REQUISITION_A) at
      // ascending created_at; ordering by DESC should return them in
      // reverse.
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_1,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: EXAM_A,
        state: 'surfaced',
        created_at: '2026-05-23T10:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_2,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'evaluated',
        created_at: '2026-05-24T10:00:00Z',
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_3,
        tenant_id: TENANT_A,
        talent_id: TALENT_B,
        requisition_id: REQUISITION_B,
        examination_id: EXAM_A,
        state: 'engaged',
        created_at: '2026-05-25T10:00:00Z',
      });

      // Tenant B: same (talent, requisition) pair as Tenant A's first
      // engagement — verifies tenant isolation.
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_TENANT_B,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        requisition_id: REQUISITION_A,
        examination_id: null,
        state: 'surfaced',
        created_at: '2026-05-24T10:00:00Z',
      });
    }, 180_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('findById returns the row and projects the typed view shape', async () => {
      const view = await repo.findById(ENGAGEMENT_1);
      expect(view).not.toBeNull();
      expect(view?.id).toBe(ENGAGEMENT_1);
      expect(view?.tenant_id).toBe(TENANT_A);
      expect(view?.talent_id).toBe(TALENT_A);
      expect(view?.requisition_id).toBe(REQUISITION_A);
      expect(view?.examination_id).toBe(EXAM_A);
      expect(view?.state).toBe('surfaced');
      expect(view?.created_at).toBeInstanceOf(Date);
    });

    it('findById returns null on unknown id', async () => {
      const view = await repo.findById('99999999-9999-7999-8999-999999999999');
      expect(view).toBeNull();
    });

    it('findById projects nullable examination_id as null', async () => {
      const view = await repo.findById(ENGAGEMENT_2);
      expect(view).not.toBeNull();
      expect(view?.examination_id).toBeNull();
    });

    it('findByTenantAndId is tenant-scoped (cross-tenant returns null)', async () => {
      const hit = await repo.findByTenantAndId({
        tenant_id: TENANT_A,
        id: ENGAGEMENT_1,
      });
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe(ENGAGEMENT_1);

      // Same id, wrong tenant → null (Architecture §7.2 cross-tenant
      // surface is invisibility, not 403).
      const miss = await repo.findByTenantAndId({
        tenant_id: TENANT_B,
        id: ENGAGEMENT_1,
      });
      expect(miss).toBeNull();
    });

    it('findByTenantAndTalent returns DESC by created_at and filters by tenant', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
      });
      // Tenant A has two engagements for TALENT_A (ENGAGEMENT_1,
      // ENGAGEMENT_2). The tenant-B row for the same talent is filtered
      // out by tenant scope.
      expect(views).toHaveLength(2);
      expect(views[0]?.id).toBe(ENGAGEMENT_2);
      expect(views[1]?.id).toBe(ENGAGEMENT_1);
    });

    it('findByTenantAndTalent returns [] for unknown talent', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: '99999999-9999-7999-8999-999999999999',
      });
      expect(views).toEqual([]);
    });

    it('findByTenantAndRequisition returns DESC by created_at and filters by tenant', async () => {
      const views = await repo.findByTenantAndRequisition({
        tenant_id: TENANT_A,
        requisition_id: REQUISITION_A,
      });
      expect(views).toHaveLength(2);
      expect(views[0]?.id).toBe(ENGAGEMENT_2);
      expect(views[1]?.id).toBe(ENGAGEMENT_1);
    });

    it('findByTenantAndRequisition cross-tenant isolation', async () => {
      const tenantBViews = await repo.findByTenantAndRequisition({
        tenant_id: TENANT_B,
        requisition_id: REQUISITION_A,
      });
      // Tenant B has its own row for REQUISITION_A — must NOT see
      // tenant A's engagements for the same requisition.
      expect(tenantBViews).toHaveLength(1);
      expect(tenantBViews[0]?.id).toBe(ENGAGEMENT_TENANT_B);
      expect(tenantBViews[0]?.tenant_id).toBe(TENANT_B);
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedEngagement(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    examination_id: string | null;
    state: string;
    created_at: string;
  },
): Promise<void> {
  // Raw SQL seed. INSERT path is unconstrained by the column-scoped
  // immutability trigger (which fires on UPDATE only).
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentJobEngagement" (
       id, tenant_id, talent_id, requisition_id, examination_id, state, created_at
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.requisition_id}'::uuid,
       ${opts.examination_id === null ? 'NULL' : `'${opts.examination_id}'::uuid`},
       '${opts.state}'::engagement."EngagementState",
       '${opts.created_at}'::timestamptz
     )`,
  );
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
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
