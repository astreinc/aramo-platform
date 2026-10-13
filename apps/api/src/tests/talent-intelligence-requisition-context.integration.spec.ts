import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, type VisibilityContextShape } from '@aramo/common';
import {
  COMPANY_CLIENT_CHECK_PORT,
  RequisitionModule,
  RequisitionRepository,
  RequisitionSkillRequirementRepository,
} from '@aramo/requisition';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RequisitionContextReadAdapter } from '../talent-intelligence/requisition-context-read.adapter.js';

// libs/requisition specs provide a fake for the company-backed CLIENT check port
// (the adapter under test never uses it — RequisitionController requires it to
// construct). @Global so it resolves inside RequisitionModule's encapsulation.
@Global()
@Module({
  providers: [
    { provide: COMPANY_CLIENT_CHECK_PORT, useValue: { isClientCompany: async () => true } },
  ],
  exports: [COMPANY_CLIENT_CHECK_PORT],
})
class StubCompanyClientCheckModule {}

// TIP-E2E INC-2 Gate-5 closure (A) — REAL-DB proof that resolveContexts enforces the
// authoritative Requisition visibility predicate (buildVisibilityWhere) through the
// real RequisitionRepository, NOT a mock. Option-A reconciliation: client-visibility
// + direct-assignment axes; NO requisition-site filter (a different-site but
// actor-visible requisition remains visible). Cross-tenant / invisible / nonexistent
// ids never appear; the port — not the caller — enforces the batch filter.
const ROOT = resolve(__dirname, '../../../..');
const REQUISITION_MIGRATIONS = [
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260609120000_search_pr1_pg_trgm_gin/migration.sql',
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
  'libs/requisition/prisma/migrations/20260612120000_drop_legacy_requisition_comp/migration.sql',
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
  'libs/requisition/prisma/migrations/20260721000000_add_publish_surface/migration.sql',
  'libs/requisition/prisma/migrations/20260801120000_add_version_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260802140000_add_onsite_days_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260802180000_add_requisition_number/migration.sql',
  'libs/requisition/prisma/migrations/20260802160000_add_user_requisition_state/migration.sql',
  'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql',
  'libs/requisition/prisma/migrations/20260907120000_add_requisition_postal_code/migration.sql',
];

const TENANT = '11111111-1111-7111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-7222-8222-222222222222';
const ACTOR_USER = '00000000-0000-7000-8000-0000000000a1';
const CLIENT_VISIBLE = 'cccccccc-cccc-7ccc-8ccc-00000000c001';
const CLIENT_HIDDEN = 'cccccccc-cccc-7ccc-8ccc-00000000c002';
const SITE_1 = '55555555-5555-7555-8555-000000005001';
const SITE_2 = '55555555-5555-7555-8555-000000005002';

const R_CLIENT = 'aaaaaaaa-0000-7000-8000-000000000001'; // visible via client
const R_ASSIGNED = 'aaaaaaaa-0000-7000-8000-000000000002'; // visible via direct assignment
const R_INVISIBLE = 'aaaaaaaa-0000-7000-8000-000000000003'; // hidden client, no assignment
const R_CROSS_TENANT = 'aaaaaaaa-0000-7000-8000-000000000004'; // other tenant
const R_DIFF_SITE_VISIBLE = 'aaaaaaaa-0000-7000-8000-000000000005'; // visible client, different site
const R_NONEXISTENT = 'aaaaaaaa-0000-7000-8000-00000000dead';

const ACTOR: VisibilityContextShape = {
  tenant_id: TENANT,
  actor_user_id: ACTOR_USER,
  see_all_company: false,
  see_all_requisition: false,
  visible_client_ids: new Set<string>([CLIENT_VISIBLE]),
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionContextReadAdapter.resolveContexts — real-DB visibility (INC-2 §3.1 / Option A)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let adapter: RequisitionContextReadAdapter;
    let savedDbUrl: string | undefined;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const rel of REQUISITION_MIGRATIONS) {
        await setup.query(readFileSync(resolve(ROOT, rel), 'utf8'));
      }
      const insertReq = async (
        id: string,
        tenant: string,
        company: string,
        site: string,
        n: number,
      ): Promise<void> => {
        await setup.query(
          `INSERT INTO requisition."Requisition"
             (id, tenant_id, title, company_id, status, requisition_number, site_id)
           VALUES ($1,$2,$3::text,$4,'open'::requisition."RecruitingStatus",$5,$6)`,
          [id, tenant, 'Senior Engineer', company, n, site],
        );
      };
      await insertReq(R_CLIENT, TENANT, CLIENT_VISIBLE, SITE_1, 1001);
      await insertReq(R_ASSIGNED, TENANT, CLIENT_HIDDEN, SITE_1, 1002);
      await insertReq(R_INVISIBLE, TENANT, CLIENT_HIDDEN, SITE_1, 1003);
      await insertReq(R_CROSS_TENANT, OTHER_TENANT, CLIENT_VISIBLE, SITE_1, 1004);
      await insertReq(R_DIFF_SITE_VISIBLE, TENANT, CLIENT_VISIBLE, SITE_2, 1005);
      // Direct assignment for the assignment-axis requisition.
      await setup.query(
        `INSERT INTO requisition."RequisitionAssignment" (tenant_id, requisition_id, user_id)
         VALUES ($1,$2,$3)`,
        [TENANT, R_ASSIGNED, ACTOR_USER],
      );
      await setup.end();

      savedDbUrl = process.env['DATABASE_URL'];
      process.env['DATABASE_URL'] = url;
      module = await Test.createTestingModule({
        imports: [StubCompanyClientCheckModule, RequisitionModule],
      }).compile();
      adapter = new RequisitionContextReadAdapter(
        module.get(RequisitionRepository),
        module.get(RequisitionSkillRequirementRepository),
      );
    }, 120_000);

    afterAll(async () => {
      await module?.close();
      if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = savedDbUrl;
      await container?.stop();
    });

    it('returns ONLY actor-authorized requisitions (client + assignment axes); different-site-but-visible INCLUDED; cross-tenant / invisible / nonexistent EXCLUDED', async () => {
      const map = await adapter.resolveContexts({
        tenant_id: TENANT,
        actor: ACTOR,
        requisition_ids: [
          R_CLIENT,
          R_ASSIGNED,
          R_INVISIBLE,
          R_CROSS_TENANT,
          R_DIFF_SITE_VISIBLE,
          R_NONEXISTENT,
        ],
      });
      // 1 + 4: only authorized ids; the port enforced the batch filter.
      expect([...map.keys()].sort()).toEqual(
        [R_CLIENT, R_ASSIGNED, R_DIFF_SITE_VISIBLE].sort(),
      );
      // 2: different-site-but-authorized remains visible.
      expect(map.has(R_DIFF_SITE_VISIBLE)).toBe(true);
      // 3: cross-tenant + invisible + nonexistent never appear.
      expect(map.has(R_CROSS_TENANT)).toBe(false);
      expect(map.has(R_INVISIBLE)).toBe(false);
      expect(map.has(R_NONEXISTENT)).toBe(false);
      // 5: summary shape preserved (non-null id/number/title/company_id/status).
      const s = map.get(R_CLIENT)!;
      expect(s.company_id).toBe(CLIENT_VISIBLE);
      expect(s.requisition_number).toBe(1001);
      expect(s.status).toBe('open');
    });

    it('see-all actor sees all tenant requisitions (6: existing semantics unchanged)', async () => {
      const seeAll: VisibilityContextShape = {
        tenant_id: TENANT,
        actor_user_id: ACTOR_USER,
        see_all_company: true,
        see_all_requisition: true,
        visible_client_ids: null,
      };
      const map = await adapter.resolveContexts({
        tenant_id: TENANT,
        actor: seeAll,
        requisition_ids: [R_CLIENT, R_ASSIGNED, R_INVISIBLE, R_DIFF_SITE_VISIBLE],
      });
      // All in-tenant ids visible to a see-all actor; cross-tenant still excluded.
      expect([...map.keys()].sort()).toEqual(
        [R_CLIENT, R_ASSIGNED, R_INVISIBLE, R_DIFF_SITE_VISIBLE].sort(),
      );
    });
  },
);
