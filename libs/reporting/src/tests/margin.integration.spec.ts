import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import { PrismaService, CommercialMarginReadRepository } from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B5 (§5/§7) — bearing libs/reporting integration proof (real Postgres 17): the
// ReportingService.getMargin FOLD over the REAL placement CommercialMarginReadRepository.
// The weighted arithmetic + ambiguity fail-closed are proven exhaustively in the
// placement lib's commercial-margin-read.integration.spec; here we tie the SERVICE fold
// (coverage label + counts + group pass-through, NO reimplementation) and the AV-1
// site-narrowing resolution (resolveSiteNarrowedRequisitionIds) to real placement data
// end to end. The requisition repo is a controlled stub: see_all + explicit site →
// findRequisitionIdsForTenantSite; see_all + no site → tenant-wide.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260815120000_t7_p2_falloff_remedy',
  '20260816120000_t7_p3_guarantee_term_versioning',
].map((d) =>
  resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`),
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const PAST = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-03-01T00:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B5 reporting margin fold + AV-1 site narrowing (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    // The requisition ids the site-narrowing stub returns for a see_all + site actor.
    let siteScopedReqIds: string[] = [];

    function makeService(): ReportingService {
      const margin = new CommercialMarginReadRepository(prisma);
      const requisitionRepository = {
        // AV-1: see_all + explicit site resolves through here.
        findRequisitionIdsForTenantSite: async () => siteScopedReqIds,
        // non-see_all path (unused by the see_all actors below).
        listForActor: async () => [],
      };
      return new ReportingService(
        {} as never, {} as never, {} as never, {} as never, {} as never,
        {} as never,
        requisitionRepository as never, // requisition
        {} as never, {} as never, {} as never, {} as never, {} as never,
        {} as never, // guaranteeExposureRepository (T7-P4; unused here)
        margin, // commercialMarginRepository
      );
    }

    async function seedCommercialized(o: {
      tenant_id: string; requisition_id: string;
      pay: string; bill: string; currency: string; rate_period: string;
    }): Promise<void> {
      const ca = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id,
            talent_record_id, started_at, provenance, lifecycle_state, company_id, end_reason)
         VALUES ('${ca}','${o.tenant_id}','${randomUUID()}','${randomUUID()}',
            '${o.requisition_id}','${randomUUID()}','${PAST}','FORWARD','ACTIVE','${randomUUID()}', NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id,
            pay_rate_amount, bill_rate_amount, currency, rate_period,
            effective_from, effective_to, recorded_by, cancelled_at)
         VALUES ('${randomUUID()}','${o.tenant_id}','${ca}','${o.requisition_id}','${randomUUID()}',
            ${o.pay}, ${o.bill}, '${o.currency}', '${o.rate_period}', '${PAST}', NULL, '${randomUUID()}', NULL)`,
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    const seeAll = (site_id?: string) => ({
      tenant_id: 'unused',
      user_id: 'u',
      scopes: ['report:read', 'assignment:commercials:read'],
      visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
      ...(site_id === undefined ? {} : { site_id }),
    });

    it('folds real placement margin: grouping, group_margin_percent, counts, deterministic order', async () => {
      const t = randomUUID();
      const req = randomUUID();
      // A(80/100) + B(10/20) USD·HOURLY → 25.00; one USD·ANNUAL 0-bill → null; one missing.
      await seedCommercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00', currency: 'USD', rate_period: 'HOURLY' });
      await seedCommercialized({ tenant_id: t, requisition_id: req, pay: '10.00', bill: '20.00', currency: 'USD', rate_period: 'HOURLY' });
      await seedCommercialized({ tenant_id: t, requisition_id: req, pay: '50.00', bill: '0.00', currency: 'USD', rate_period: 'ANNUAL' });
      // an ACTIVE assignment with NO current version → missing.
      await prisma.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id, talent_record_id,
            started_at, provenance, lifecycle_state, company_id, end_reason)
         VALUES ('${randomUUID()}','${t}','${randomUUID()}','${randomUUID()}','${req}','${randomUUID()}',
            '${PAST}','FORWARD','ACTIVE','${randomUUID()}', NULL)`,
      );

      const v = await makeService().getMargin({ ...seeAll(), tenant_id: t }, 'req-1', { now: NOW });
      expect(v.coverage).toBe('forward_materialized');
      expect(v.eligible_count).toBe(4);
      expect(v.commercialized_count).toBe(3);
      expect(v.missing_commercial_count).toBe(1);
      expect(v.eligible_count).toBe(v.commercialized_count + v.missing_commercial_count);
      // deterministic order: currency ASC then HOURLY before ANNUAL.
      expect(v.groups.map((g) => `${g.currency}/${g.rate_period}`)).toEqual([
        'USD/HOURLY', 'USD/ANNUAL',
      ]);
      const usdHourly = v.groups.find((g) => g.rate_period === 'HOURLY');
      expect(usdHourly?.group_margin_percent).toBe('25.00'); // weighted, not the 35% mean
      expect(usdHourly?.assignment_count).toBe(2);
      const usdAnnual = v.groups.find((g) => g.rate_period === 'ANNUAL');
      expect(usdAnnual?.group_margin_percent).toBeNull(); // zero group bill
    });

    it('AV-1: see_all + explicit site narrows to the site-scoped requisitions', async () => {
      const t = randomUUID();
      const reqSiteA = randomUUID();
      const reqSiteB = randomUUID();
      await seedCommercialized({ tenant_id: t, requisition_id: reqSiteA, pay: '80.00', bill: '100.00', currency: 'USD', rate_period: 'HOURLY' });
      await seedCommercialized({ tenant_id: t, requisition_id: reqSiteB, pay: '50.00', bill: '100.00', currency: 'CAD', rate_period: 'HOURLY' });

      // see_all + no site → tenant-wide (both groups).
      const all = await makeService().getMargin({ ...seeAll(), tenant_id: t }, 'req-2', { now: NOW });
      expect(all.groups.map((g) => g.currency).sort()).toEqual(['CAD', 'USD']);

      // see_all + site → resolver returns only reqSiteA → only the USD group.
      siteScopedReqIds = [reqSiteA];
      const siteA = await makeService().getMargin({ ...seeAll('site-a'), tenant_id: t }, 'req-3', { now: NOW });
      expect(siteA.groups.map((g) => g.currency)).toEqual(['USD']);
      expect(siteA.groups.some((g) => g.currency === 'CAD')).toBe(false);
      expect(siteA.eligible_count).toBe(1);

      // explicit site that resolves to NO requisitions → empty aggregate.
      siteScopedReqIds = [];
      const empty = await makeService().getMargin({ ...seeAll('site-empty'), tenant_id: t }, 'req-4', { now: NOW });
      expect(empty.eligible_count).toBe(0);
      expect(empty.groups).toHaveLength(0);
    });
  },
);
