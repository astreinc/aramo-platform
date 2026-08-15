import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { CommercialMarginReadRepository } from '../lib/commercial-margin-read.repository.js';

// T9-B4 — the BEARING libs/placement proof (real Postgres 17) for the current-
// snapshot commercial margin aggregate. Governed by Aramo-T9-B4-Directive-v1_0-LOCKED.
// Proves (§39): eligible population (ACTIVE CONTRACT only; ENDED / future / cancelled
// excluded; missing counted), the GOVERNED weighted aggregate returning 25.00% (NOT
// the 35.00% simple mean), zero-bill→null, negative margin, currency + rate-period
// grouping with deterministic order, the coverage-count invariant, A3 visible-req
// subsetting, and — the Architect's hard gate — fail-closed commercial ambiguity in a
// SET-BASED query (a corrupt >1-current-version assignment throws INTERNAL_ERROR and
// is never double-counted or latest-wins-collapsed).

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
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

const OVERLAP_CONSTRAINT = 'AssignmentRateVersion_no_window_overlap_excl';

// Dollar-quote-aware, line-comment-blind splitter (mirrors the sibling specs).
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

// Fixed, ordered instants. PAST < NOW-anchor < FUTURE. `now` passed explicitly so
// the aggregate never depends on wall-clock.
const PAST = '2026-01-01T00:00:00.000Z';
const NOW = '2026-03-01T00:00:00.000Z';
const FUTURE = '2026-06-01T00:00:00.000Z';
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B4 commercial margin read (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: CommercialMarginReadRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      client = new PrismaService(container.getConnectionUri());
      await client.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await client.$executeRawUnsafe(t);
        }
      }
      repo = new CommercialMarginReadRepository(client);
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    // A CONTRACT assignment. FORWARD provenance carries lifecycle_state + company_id
    // (the two forward CHECKs); ENDED carries an end_reason (the end-reason CHECK).
    async function insertAssignment(o: {
      tenant_id: string;
      requisition_id: string;
      lifecycle_state: 'ACTIVE' | 'ENDED';
      id?: string;
    }): Promise<string> {
      const id = o.id ?? randomUUID();
      const endReason = o.lifecycle_state === 'ENDED' ? `'COMPLETED'` : 'NULL';
      await client.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id,
            talent_record_id, started_at, provenance, lifecycle_state, company_id, end_reason)
         VALUES ('${id}','${o.tenant_id}','${randomUUID()}','${randomUUID()}',
            '${o.requisition_id}','${randomUUID()}','${PAST}','FORWARD',
            '${o.lifecycle_state}','${randomUUID()}', ${endReason})`,
      );
      return id;
    }

    // An AssignmentRateVersion row inserted directly (UUID-only refs, no FK).
    async function insertVersion(o: {
      tenant_id: string;
      contract_assignment_id: string;
      pay: string;
      bill: string;
      currency?: string;
      rate_period?: string;
      effective_from?: string;
      effective_to?: string | null;
      cancelled_at?: string | null;
    }): Promise<string> {
      const id = randomUUID();
      await client.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id,
            pay_rate_amount, bill_rate_amount, currency, rate_period,
            effective_from, effective_to, recorded_by, cancelled_at)
         VALUES ('${id}','${o.tenant_id}','${o.contract_assignment_id}',
            '${randomUUID()}','${randomUUID()}',
            ${o.pay}, ${o.bill}, '${o.currency ?? 'USD'}', '${o.rate_period ?? 'HOURLY'}',
            '${o.effective_from ?? PAST}', ${q(o.effective_to ?? null)},
            '${randomUUID()}', ${q(o.cancelled_at ?? null)})`,
      );
      return id;
    }

    // Seed one commercialized ACTIVE assignment (assignment + current open version).
    async function commercialized(o: {
      tenant_id: string; requisition_id: string;
      pay: string; bill: string; currency?: string; rate_period?: string;
    }): Promise<string> {
      const ca = await insertAssignment({
        tenant_id: o.tenant_id, requisition_id: o.requisition_id, lifecycle_state: 'ACTIVE',
      });
      await insertVersion({ tenant_id: o.tenant_id, contract_assignment_id: ca, ...o });
      return ca;
    }

    // ---- §8 governed weighted aggregate: 25.00%, NOT the 35% simple mean ----
    it('folds A(80/100) + B(10/20) into ONE USD·HOURLY group = 25.00% (not the 35% mean)', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00' });
      await commercialized({ tenant_id: t, requisition_id: req, pay: '10.00', bill: '20.00' });

      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      expect(snap.groups).toHaveLength(1);
      const g = snap.groups[0]!;
      expect(g.currency).toBe('USD');
      expect(g.rate_period).toBe('HOURLY');
      expect(g.assignment_count).toBe(2);
      // ((100-80)+(20-10)) / (100+20) = 30/120 = 25.00%. The mean of 20% & 50% is 35%.
      expect(g.group_margin_percent).toBe('25.00');
      expect(g.group_margin_percent).not.toBe('35.00');
      expect(snap.eligible_count).toBe(2);
      expect(snap.commercialized_count).toBe(2);
      expect(snap.missing_commercial_count).toBe(0);
    });

    // ---- §8 zero aggregate bill → null ----
    it('a group whose bill total is zero yields margin_percent = null', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '50.00', bill: '0.00' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      expect(snap.groups).toHaveLength(1);
      expect(snap.groups[0]!.group_margin_percent).toBeNull();
    });

    // ---- §25 negative group spread → negative margin ----
    it('a negative group spread yields a negative margin_percent', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '100.00', bill: '80.00' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      // spread=-20, margin=-20/80*100 = -25.00
      expect(snap.groups[0]!.group_margin_percent).toBe('-25.00');
    });

    // ---- §25 no float drift (Decimal half-up on repeating fraction) ----
    it('computes without float drift (0.10/0.30 ×3 → 66.67)', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '0.10', bill: '0.30' });
      await commercialized({ tenant_id: t, requisition_id: req, pay: '0.10', bill: '0.30' });
      await commercialized({ tenant_id: t, requisition_id: req, pay: '0.10', bill: '0.30' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      // sum_pay=0.30, sum_bill=0.90, margin=0.60/0.90*100 = 66.666… → 66.67
      expect(snap.groups[0]!.group_margin_percent).toBe('66.67');
    });

    // ---- §9/§10 currency and rate-period grouping + deterministic order ----
    it('separates USD·HOURLY, CAD·HOURLY, USD·ANNUAL into ordered groups; no folding', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00', currency: 'USD', rate_period: 'HOURLY' });
      await commercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00', currency: 'CAD', rate_period: 'HOURLY' });
      await commercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00', currency: 'USD', rate_period: 'ANNUAL' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      // Deterministic order: currency ASC then canonical rate-period (HOURLY<ANNUAL).
      expect(snap.groups.map((g) => `${g.currency}/${g.rate_period}`)).toEqual([
        'CAD/HOURLY', 'USD/HOURLY', 'USD/ANNUAL',
      ]);
      for (const g of snap.groups) expect(g.assignment_count).toBe(1);
    });

    // ---- §4/§17/§16/§11 population boundaries ----
    it('excludes ENDED assignments even when they carry a current version', async () => {
      const t = randomUUID(); const req = randomUUID();
      const ended = await insertAssignment({ tenant_id: t, requisition_id: req, lifecycle_state: 'ENDED' });
      await insertVersion({ tenant_id: t, contract_assignment_id: ended, pay: '80.00', bill: '100.00' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      expect(snap.eligible_count).toBe(0);
      expect(snap.groups).toHaveLength(0);
    });

    it('counts an ACTIVE assignment with NO current version as missing, never dropped', async () => {
      const t = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: req, pay: '80.00', bill: '100.00' });
      // future-only version → no current effective row
      const futureOnly = await insertAssignment({ tenant_id: t, requisition_id: req, lifecycle_state: 'ACTIVE' });
      await insertVersion({ tenant_id: t, contract_assignment_id: futureOnly, pay: '5.00', bill: '9.00', effective_from: FUTURE });
      // cancelled-only version → no current effective row
      const cancelledOnly = await insertAssignment({ tenant_id: t, requisition_id: req, lifecycle_state: 'ACTIVE' });
      await insertVersion({ tenant_id: t, contract_assignment_id: cancelledOnly, pay: '5.00', bill: '9.00', cancelled_at: NOW });
      // no-version-at-all
      await insertAssignment({ tenant_id: t, requisition_id: req, lifecycle_state: 'ACTIVE' });

      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      expect(snap.eligible_count).toBe(4);
      expect(snap.commercialized_count).toBe(1);
      expect(snap.missing_commercial_count).toBe(3);
      // invariant
      expect(snap.eligible_count).toBe(snap.commercialized_count + snap.missing_commercial_count);
      // the future 5/9 and cancelled 5/9 must NOT enter any group
      expect(snap.groups).toHaveLength(1);
      expect(snap.groups[0]!.group_margin_percent).toBe('20.00');
    });

    // ---- §21 A3 visible-requisition subsetting ----
    it('constrains aggregation to the visible requisition subset', async () => {
      const t = randomUUID(); const reqA = randomUUID(); const reqB = randomUUID();
      await commercialized({ tenant_id: t, requisition_id: reqA, pay: '80.00', bill: '100.00' });
      await commercialized({ tenant_id: t, requisition_id: reqB, pay: '0.00', bill: '100.00' });
      // see-all (undefined) → both
      const all = await repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(NOW) });
      expect(all.eligible_count).toBe(2);
      // visible = [reqA] only → 1 assignment, the 80/100 → 20.00
      const subset = await repo.readCurrentMarginSnapshot({ tenant_id: t, requisition_ids: [reqA], now: new Date(NOW) });
      expect(subset.eligible_count).toBe(1);
      expect(subset.groups[0]!.group_margin_percent).toBe('20.00');
      // empty visible-set → all-zero
      const none = await repo.readCurrentMarginSnapshot({ tenant_id: t, requisition_ids: [], now: new Date(NOW) });
      expect(none.eligible_count).toBe(0);
      expect(none.groups).toHaveLength(0);
    });

    // ---- §8/§11/§20 THE ambiguity gate: >1 current version fails closed ----
    // The write-time btree_gist EXCLUDE prevents overlapping non-cancelled windows,
    // so a corrupt overlap is injected in a scoped, self-restoring DDL window (drop
    // EXCLUDE → inject → assert → tenant-reset delete → re-add). The set-based read
    // MUST throw INTERNAL_ERROR, never silently double-count or pick a latest winner.
    it('fails closed (INTERNAL_ERROR/500) on a corrupt >1-current-version assignment', async () => {
      const t = randomUUID(); const req = randomUUID();
      const ca = await insertAssignment({ tenant_id: t, requisition_id: req, lifecycle_state: 'ACTIVE' });
      await client.$executeRawUnsafe(
        `ALTER TABLE placement."AssignmentRateVersion" DROP CONSTRAINT "${OVERLAP_CONSTRAINT}"`,
      );
      try {
        await insertVersion({ tenant_id: t, contract_assignment_id: ca, pay: '80.00', bill: '100.00', effective_from: PAST, effective_to: null });
        await insertVersion({ tenant_id: t, contract_assignment_id: ca, pay: '10.00', bill: '20.00', effective_from: NOW, effective_to: null });
        await expect(
          repo.readCurrentMarginSnapshot({ tenant_id: t, now: new Date(FUTURE) }),
        ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
      } finally {
        await client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
          await tx.$executeRawUnsafe(`DELETE FROM placement."AssignmentRateVersion" WHERE tenant_id = '${t}'`);
        });
        await client.$executeRawUnsafe(
          `ALTER TABLE placement."AssignmentRateVersion"
             ADD CONSTRAINT "${OVERLAP_CONSTRAINT}" EXCLUDE USING gist (
               "tenant_id" public.gist_uuid_ops WITH =,
               "contract_assignment_id" public.gist_uuid_ops WITH =,
               tstzrange("effective_from", COALESCE("effective_to", 'infinity'), '[)') WITH &&
             ) WHERE ("cancelled_at" IS NULL)`,
        );
      }
    });

    // ---- tenant isolation ----
    it('never crosses tenants', async () => {
      const t1 = randomUUID(); const t2 = randomUUID(); const req = randomUUID();
      await commercialized({ tenant_id: t1, requisition_id: req, pay: '80.00', bill: '100.00' });
      await commercialized({ tenant_id: t2, requisition_id: req, pay: '0.00', bill: '100.00' });
      const snap = await repo.readCurrentMarginSnapshot({ tenant_id: t1, now: new Date(NOW) });
      expect(snap.eligible_count).toBe(1);
      expect(snap.groups[0]!.group_margin_percent).toBe('20.00');
    });
  },
);
