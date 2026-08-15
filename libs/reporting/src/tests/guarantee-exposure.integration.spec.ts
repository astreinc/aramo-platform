import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import { PrismaService, GuaranteeExposureReadRepository } from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// T7-P4 — bearing libs/reporting integration: the guarantee-exposure aggregate over the REAL
// immutable PermanentPlacement snapshot + PermanentPlacementRemedy facts, folded through
// ReportingService.getGuaranteeExposure. Cohort = created_at (activation instant) in [from,to).
// Money is per-currency only (never summed/converted); obligations are owed, not paid. Proves
// the directive §14 matrix end to end on Postgres 17.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260806090000_placement_tenant_reset_escape',
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
].map((d) => resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`));

const P_FROM = new Date('2026-01-01T00:00:00.000Z');
const P_TO = new Date('2026-02-01T00:00:00.000Z');
const IN = new Date('2026-01-15T00:00:00.000Z');

function splitDdl(sql: string): string[] {
  const out: string[] = []; let cur = ''; let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T7-P4 guarantee-exposure report (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: ReportingService;
    let visibleReqs: Array<{ id: string }> = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t) await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      const repo = new GuaranteeExposureReadRepository(prisma);
      const reqRepoStub = { listForActor: async () => visibleReqs } as never;
      svc = new ReportingService(
        {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
        reqRepoStub, // 7 requisitionRepository (drives filtered visibility)
        {} as never, {} as never, {} as never, {} as never, {} as never, // 8-12
        repo, // 13 guaranteeExposureRepository
      );
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function pp(o: {
      tenant: string; state: string; exposure: string; currency: string;
      req?: string; created_at?: Date; remedy_policy?: string;
    }): Promise<string> {
      const id = randomUUID();
      await prisma.permanentPlacement.create({
        data: {
          id,
          tenant_id: o.tenant,
          placement_process_id: randomUUID(),
          submittal_id: randomUUID(),
          requisition_id: o.req ?? randomUUID(),
          talent_record_id: randomUUID(),
          lifecycle_state: o.state as never,
          guarantee_start_date: new Date('2026-01-01T00:00:00.000Z'),
          guarantee_duration_days: 365,
          guarantee_end_date: new Date('2027-01-01T00:00:00.000Z'),
          remedy_policy: (o.remedy_policy ?? 'REFUND') as never,
          guarantee_exposure_amount: o.exposure,
          guarantee_exposure_currency: o.currency,
          terms_source: 'test',
          recorded_by: randomUUID(),
          created_at: o.created_at ?? IN,
        },
      });
      return id;
    }
    async function remedy(o: {
      tenant: string; ppId: string; remedy_type: 'REPLACEMENT' | 'REFUND' | 'PRORATED_CREDIT';
      amount?: string; currency?: string;
    }): Promise<void> {
      await prisma.permanentPlacementRemedy.create({
        data: {
          id: randomUUID(),
          tenant_id: o.tenant,
          permanent_placement_id: o.ppId,
          requisition_id: randomUUID(),
          talent_record_id: randomUUID(),
          remedy_type: o.remedy_type as never,
          calculated_amount: o.amount ?? null,
          currency: o.currency ?? null,
          exposure_amount_snapshot: '50000.00',
          duration_days_snapshot: 365,
          remaining_days: o.remedy_type === 'PRORATED_CREDIT' ? 180 : null,
          falloff_effective_date: new Date('2026-06-01T00:00:00.000Z'),
          created_by: randomUUID(),
          due_at: IN,
        },
      });
    }
    function seeAll(tenant: string) {
      return { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: { see_all_requisition: true } as unknown as VisibilityContextShape };
    }
    function filtered(tenant: string) {
      return { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: { see_all_requisition: false } as unknown as VisibilityContextShape };
    }
    const ccyBucket = <T extends { currency: string }>(arr: T[], ccy: string): T | undefined => arr.find((b) => b.currency === ccy);

    // 1 — empty cohort
    it('1 — empty cohort → zeros, empty currency buckets, falloff_rate 0', async () => {
      const t = randomUUID();
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(0);
      expect(v.exposure_by_currency).toEqual([]);
      expect(v.remedy_obligation_by_currency).toEqual([]);
      expect(v.states).toEqual({ active: 0, satisfied: 0, fell_off: 0, remedy_due: { replacement: 0, refund: 0, prorated_credit: 0 }, remedy_completed: 0 });
      expect(v.falloff_rate).toBe(0);
      expect(v.period).toEqual({ from: P_FROM.toISOString(), to: P_TO.toISOString() });
    });

    // 2 — tenant isolation
    it('2 — tenant isolation: another tenant sees nothing', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD' });
      const other = await svc.getGuaranteeExposure(seeAll(randomUUID()), { from: P_FROM, to: P_TO });
      expect(other.cohort_count).toBe(0);
    });

    // 3+4+5 — active / satisfied / fell-off exposure + at_risk
    it('3+4+5 — active/satisfied/fell-off exposure buckets; at_risk == active', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD' });
      await pp({ tenant: t, state: 'GUARANTEE_SATISFIED', exposure: '20000.00', currency: 'USD' });
      await pp({ tenant: t, state: 'REFUND_DUE', exposure: '30000.00', currency: 'USD' }); // fell-off family
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(3);
      const usd = ccyBucket(v.exposure_by_currency, 'USD')!;
      expect(usd.total).toBe('60000.00');
      expect(usd.active).toBe('10000.00');
      expect(usd.satisfied).toBe('20000.00');
      expect(usd.fell_off).toBe('30000.00');
      expect(usd.at_risk).toBe('10000.00'); // == active
      expect(v.states.active).toBe(1);
      expect(v.states.satisfied).toBe(1);
      expect(v.states.fell_off).toBe(1);
      expect(v.states.remedy_due.refund).toBe(1);
      // falloff_rate = 1/3 -> round(33.3) = 33 (percent)
      expect(v.falloff_rate).toBe(33);
    });

    // 6+7+8 — remedy-due state counts + obligation amounts (REPLACEMENT none; REFUND/PRORATED amount)
    it('6+7+8 — REPLACEMENT_DUE has no obligation; REFUND_DUE + PRORATED_CREDIT_DUE amounts sum per currency', async () => {
      const t = randomUUID();
      const rep = await pp({ tenant: t, state: 'REPLACEMENT_DUE', exposure: '40000.00', currency: 'USD', remedy_policy: 'REPLACEMENT' });
      await remedy({ tenant: t, ppId: rep, remedy_type: 'REPLACEMENT' });
      const ref = await pp({ tenant: t, state: 'REFUND_DUE', exposure: '50000.00', currency: 'USD', remedy_policy: 'REFUND' });
      await remedy({ tenant: t, ppId: ref, remedy_type: 'REFUND', amount: '50000.00', currency: 'USD' });
      const pro = await pp({ tenant: t, state: 'PRORATED_CREDIT_DUE', exposure: '60000.00', currency: 'USD', remedy_policy: 'PRORATED_CREDIT' });
      await remedy({ tenant: t, ppId: pro, remedy_type: 'PRORATED_CREDIT', amount: '24657.53', currency: 'USD' });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.states.remedy_due).toEqual({ replacement: 1, refund: 1, prorated_credit: 1 });
      const usd = ccyBucket(v.remedy_obligation_by_currency, 'USD')!;
      expect(usd.refund_total).toBe('50000.00');
      expect(usd.prorated_credit_total).toBe('24657.53');
      // No REPLACEMENT monetary obligation appears anywhere.
      const json = JSON.stringify(v.remedy_obligation_by_currency);
      expect(json).not.toContain('replacement');
    });

    // 9 — REMEDY_COMPLETED = evidence completed, never labelled a payment
    it('9 — REMEDY_COMPLETED is counted as evidence-completed, never as paid/settled', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'REMEDY_COMPLETED', exposure: '15000.00', currency: 'USD' });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.states.remedy_completed).toBe(1);
      expect(v.states.fell_off).toBe(1); // completed is in the fell-off family
      const json = JSON.stringify(v).toLowerCase();
      for (const banned of ['paid', 'refunded', 'settled', 'executed', 'payment']) {
        expect(json).not.toContain(banned);
      }
    });

    // 10+11 — multi-currency exposure + obligations are separated; no global monetary total
    it('10+11 — currencies are separated with no cross-currency sum', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD' });
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '20000.00', currency: 'EUR' });
      const ref = await pp({ tenant: t, state: 'REFUND_DUE', exposure: '30000.00', currency: 'EUR', remedy_policy: 'REFUND' });
      await remedy({ tenant: t, ppId: ref, remedy_type: 'REFUND', amount: '30000.00', currency: 'EUR' });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.exposure_by_currency.map((b) => b.currency).sort()).toEqual(['EUR', 'USD']);
      expect(ccyBucket(v.exposure_by_currency, 'USD')!.total).toBe('10000.00');
      expect(ccyBucket(v.exposure_by_currency, 'EUR')!.total).toBe('50000.00');
      expect(ccyBucket(v.remedy_obligation_by_currency, 'EUR')!.refund_total).toBe('30000.00');
      // No synthetic global monetary total key anywhere.
      const json = JSON.stringify(v);
      for (const banned of ['grand_total', 'total_all', 'converted', 'global_total']) {
        expect(json).not.toContain(banned);
      }
    });

    // 12+13 — [from, to) boundaries: created_at == from included, == to excluded
    it('12+13 — created_at == from is included, == to is excluded', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '11111.00', currency: 'USD', created_at: P_FROM });
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '22222.00', currency: 'USD', created_at: P_TO });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(1);
      expect(ccyBucket(v.exposure_by_currency, 'USD')!.total).toBe('11111.00');
    });

    // 14 — a later P3 term revision does not change historical exposure (report reads the snapshot)
    it('14 — inserting a different guarantee-term version does not change the report exposure', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '50000.00', currency: 'USD', req });
      const before = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      // A term version with a DIFFERENT exposure lands for the same requisition — the report
      // must ignore it (exposure comes from the immutable PermanentPlacement snapshot).
      await prisma.$executeRawUnsafe(
        `INSERT INTO placement."PermanentPlacementGuaranteeTermVersion" (id, tenant_id, requisition_id, effective_from, guarantee_duration_days, remedy_policy, guarantee_exposure_amount, currency, source_type, recorded_by, recorded_at, created_at) ` +
          `VALUES ('${randomUUID()}','${t}','${req}','2026-01-01', 365, 'REFUND', 999999.00, 'USD', 'MANUAL', '${randomUUID()}', now(), now())`,
      );
      const after = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(ccyBucket(after.exposure_by_currency, 'USD')!.total).toBe('50000.00');
      expect(after).toEqual(before);
    });

    // 15+16 — P2 obligation amount parity (REFUND = exposure; PRORATED_CREDIT = proration) is reported verbatim
    it('15+16 — the persisted REFUND / PRORATED_CREDIT obligation amounts are reported verbatim', async () => {
      const t = randomUUID();
      const ref = await pp({ tenant: t, state: 'REFUND_DUE', exposure: '50000.00', currency: 'GBP', remedy_policy: 'REFUND' });
      await remedy({ tenant: t, ppId: ref, remedy_type: 'REFUND', amount: '50000.00', currency: 'GBP' });
      const pro = await pp({ tenant: t, state: 'PRORATED_CREDIT_DUE', exposure: '50000.00', currency: 'GBP', remedy_policy: 'PRORATED_CREDIT' });
      await remedy({ tenant: t, ppId: pro, remedy_type: 'PRORATED_CREDIT', amount: '12500.00', currency: 'GBP' });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      const gbp = ccyBucket(v.remedy_obligation_by_currency, 'GBP')!;
      expect(gbp.refund_total).toBe('50000.00');
      expect(gbp.prorated_credit_total).toBe('12500.00');
    });

    // 17 — visibility see-all
    it('17 — see-all visibility aggregates every requisition in the tenant', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD', req: randomUUID() });
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '20000.00', currency: 'USD', req: randomUUID() });
      const v = await svc.getGuaranteeExposure(seeAll(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(2);
      expect(ccyBucket(v.exposure_by_currency, 'USD')!.total).toBe('30000.00');
    });

    // 18 — visibility filtered to a requisition subset
    it('18 — filtered visibility restricts the cohort to the visible requisitions', async () => {
      const t = randomUUID();
      const reqA = randomUUID(); const reqB = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD', req: reqA });
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '20000.00', currency: 'USD', req: reqB });
      visibleReqs = [{ id: reqA }];
      const v = await svc.getGuaranteeExposure(filtered(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(1);
      expect(ccyBucket(v.exposure_by_currency, 'USD')!.total).toBe('10000.00');
    });

    // 19 — visibility empty-set → empty report
    it('19 — an empty visible-requisition set yields an empty report', async () => {
      const t = randomUUID();
      await pp({ tenant: t, state: 'GUARANTEE_ACTIVE', exposure: '10000.00', currency: 'USD', req: randomUUID() });
      visibleReqs = [];
      const v = await svc.getGuaranteeExposure(filtered(t), { from: P_FROM, to: P_TO });
      expect(v.cohort_count).toBe(0);
      expect(v.exposure_by_currency).toEqual([]);
    });
  },
);
