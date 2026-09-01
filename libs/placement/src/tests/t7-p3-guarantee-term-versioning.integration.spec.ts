import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PermanentPlacementRepository } from '../lib/permanent/permanent-placement.repository.js';
import { GuaranteeTermRepository } from '../lib/permanent/guarantee-term.repository.js';
import type { CreatePlacementInput, GuaranteeTermsInput, CreateGuaranteeTermVersionInput } from '../lib/placement-process.types.js';
import type { PlacementState, RemedyPolicy } from '../lib/lifecycle/placement-lifecycle.js';

import { seedAcceptedOffer } from './support/offer-fixture.js';

// Track 7 / T7-P3 — reusable, requisition-keyed, effective-dated guarantee-term versions +
// provenance + copy-at-activation. Real Postgres 17. Covers the directive §14 matrix: create,
// exact/future/boundary resolution, overlap + immutability + first-close, revision atomicity,
// copy-at-activation (values + provenance), snapshot-freeze across later revisions, P2
// snapshot-only remedy, activation precedence (stored/legacy/conflict/none), ambiguity
// fail-closed, tenant isolation, append-only DELETE + governed reset escape, and P1/P2/T6/contract
// regressions + fresh bootstrap.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260825120000_assignment_extension_horizon',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260815120000_t7_p2_falloff_remedy',
  '20260816120000_t7_p3_guarantee_term_versioning',
  '20260824120000_init_offer_model',
  '20260901130000_offer_compensation_snapshot',
  '20260824130000_placement_offer_id',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// Offer Lifecycle (D6) — born PRE_START (downstream of an ACCEPTED offer).
const PATH_TO_READY: PlacementState[] = ['READY_TO_START'];
const EXCLUDE_CONSTRAINT_DDL =
  'ALTER TABLE placement."PermanentPlacementGuaranteeTermVersion" ADD CONSTRAINT "ppgtv_no_window_overlap_excl" ' +
  'EXCLUDE USING gist ("tenant_id" public.gist_uuid_ops WITH =, "requisition_id" public.gist_uuid_ops WITH =, ' +
  "daterange(\"effective_from\", \"effective_to\", '[)') WITH &&)";

function splitDdl(sql: string): string[] {
  const out: string[] = []; let current = ''; let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; current += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(current); current = ''; } else { current += ch; }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
function baseInput(o: Partial<CreatePlacementInput> = {}): CreatePlacementInput {
  return { tenant_id: randomUUID(), submittal_id: randomUUID(), requisition_id: randomUUID(), talent_record_id: randomUUID(), ...o };
}
function isoAddDays(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function todayUtcIso(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString().slice(0, 10);
}
function termsInput(o: Partial<CreateGuaranteeTermVersionInput> = {}): CreateGuaranteeTermVersionInput {
  return {
    tenant_id: randomUUID(),
    requisition_id: randomUUID(),
    effective_from: '2026-01-01',
    guarantee_duration_days: 365,
    remedy_policy: 'REFUND',
    guarantee_exposure_amount: '50000.00',
    currency: 'USD',
    source_type: 'MANUAL',
    source_reference: null,
    source_version: null,
    correlation_id: null,
    recorded_by: randomUUID(),
    ...o,
  };
}
function legacyGuarantee(over: Partial<GuaranteeTermsInput> = {}): GuaranteeTermsInput {
  return {
    guarantee_start_date: '2026-06-01',
    guarantee_duration_days: 365,
    remedy_policy: 'REFUND',
    exposure_amount: '50000.00',
    exposure_currency: 'USD',
    terms_source: 'legacy_explicit',
    ...over,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Guarantee-term versioning — T7-P3 (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let permanent: PermanentPlacementRepository;
    let terms: GuaranteeTermRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t) await setupClient.$executeRawUnsafe(t);
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
      permanent = new PermanentPlacementRepository(prisma);
      terms = new GuaranteeTermRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Offer Lifecycle (D6) — create from an ACCEPTED offer (born PRE_START).
    async function createValid(input: CreatePlacementInput, requestId: string) {
      const offer_id = input.offer_id ?? (await seedAcceptedOffer(prisma, { tenant_id: input.tenant_id }));
      return repo.createPlacement({ ...input, offer_id }, requestId);
    }

    // Offer Lifecycle (D6) — create from an ACCEPTED offer (born PRE_START).
    async function createValid(input: CreatePlacementInput, requestId: string) {
      const offer_id = input.offer_id ?? (await seedAcceptedOffer(prisma, { tenant_id: input.tenant_id }));
      return repo.createPlacement({ ...input, offer_id }, requestId);
    }

    async function driveToReady(input: CreatePlacementInput): Promise<string> {
      const c = await createValid(input, 'd'); let id = c.id;
      for (const to of PATH_TO_READY) id = (await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'd')).id;
      return id;
    }
    // Start a PERMANENT placement relying on stored terms (standalone guarantee_start_date).
    async function startPermanentStored(input: CreatePlacementInput, startDate: string): Promise<string> {
      const id = await driveToReady(input);
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_start_date: startDate, recorded_by: randomUUID() }, 's');
      return id;
    }
    async function rawPermanent(tenant_id: string, placement_process_id: string) {
      return prisma.permanentPlacement.findFirst({ where: { tenant_id, placement_process_id } });
    }

    // ---- 25. fresh bootstrap ----
    it('25 — fresh bootstrap: the version table + provenance columns + exclusion exist', async () => {
      const cnt = await prisma.permanentPlacementGuaranteeTermVersion.count();
      expect(cnt).toBe(0);
      const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='placement' AND table_name='PermanentPlacement' AND column_name LIKE 'guarantee_terms_source%'`,
      );
      expect(cols.length).toBe(3);
    });

    // ---- 1. create + 2. exact resolution ----
    it('1+2 — create the initial open version; getEffective resolves it exactly', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const v = await terms.create(termsInput({ tenant_id: tenant, requisition_id: req, source_reference: 'batch-1', source_version: 'v1' }), 'c');
      expect(v.effective_to).toBeNull();
      expect(v.source_type).toBe('MANUAL');
      expect(v.supersedes_version_id).toBeNull();
      const eff = await terms.getEffective(tenant, req, new Date('2026-06-01T00:00:00.000Z'), 'e');
      expect(eff.id).toBe(v.id);
      expect(eff.guarantee_duration_days).toBe(365);
    });

    // ---- 5. overlap rejected (open vs open, and same effective_from) ----
    it('5 — an overlapping / duplicate effective window is TERMS_OVERLAP (409)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      await terms.create(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: '2026-01-01' }), 'c');
      await expect(
        terms.create(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: '2026-06-01' }), 'c'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_OVERLAP', statusCode: 409 });
      await expect(
        terms.create(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: '2026-01-01' }), 'c'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_OVERLAP', statusCode: 409 });
    });

    // ---- 7. first-close once + 9. revision atomic + 3. future not early + 4. boundary ----
    it('3+4+7+9 — revise first-closes the predecessor and inserts a successor; resolution honours the half-open boundary', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const boundary = isoAddDays(todayUtcIso(), 30); // >= today (no backdating)
      const pred = await terms.create(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: '2026-01-01', guarantee_duration_days: 365, remedy_policy: 'REFUND' }), 'c');
      const succ = await terms.revise(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: boundary, guarantee_duration_days: 180, remedy_policy: 'REPLACEMENT' }), 'r');
      expect(succ.supersedes_version_id).toBe(pred.id);
      expect(succ.effective_to).toBeNull();
      // Predecessor is first-closed at the boundary (atomic).
      const predAfter = (await prisma.permanentPlacementGuaranteeTermVersion.findFirst({ where: { id: pred.id } }))!;
      expect(predAfter.effective_to?.toISOString().slice(0, 10)).toBe(boundary);
      // Future successor does not apply early (day before boundary -> predecessor).
      const before = await terms.getEffective(tenant, req, new Date(`${isoAddDays(boundary, -1)}T00:00:00.000Z`), 'e');
      expect(before.id).toBe(pred.id);
      // Exact boundary resolves the successor (half-open [boundary, ...)).
      const at = await terms.getEffective(tenant, req, new Date(`${boundary}T00:00:00.000Z`), 'e');
      expect(at.id).toBe(succ.id);
      expect(at.guarantee_duration_days).toBe(180);
    });

    // ---- 6. historical payload rewrite rejected + 8. second close rejected ----
    it('6+8 — a payload rewrite and a second first-close are rejected as immutable', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const v = await terms.create(termsInput({ tenant_id: tenant, requisition_id: req }), 'c');
      // 6 — payload mutation without the governed marker is rejected by the append-only trigger.
      await expect(
        prisma.permanentPlacementGuaranteeTermVersion.update({ where: { id: v.id }, data: { guarantee_duration_days: 999 } }),
      ).rejects.toBeTruthy();
      // Close it once (marked), then a second close of the now-closed row is rejected.
      const boundary = isoAddDays(todayUtcIso(), 30);
      await terms.revise(termsInput({ tenant_id: tenant, requisition_id: req, effective_from: boundary }), 'r');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.guarantee_terms_revision = 'authorized'`);
          await tx.$executeRawUnsafe(`UPDATE placement."PermanentPlacementGuaranteeTermVersion" SET effective_to = '${isoAddDays(boundary, 10)}' WHERE id = '${v.id}'`);
        }),
      ).rejects.toBeTruthy();
    });

    // ---- 10. copy values + 11. copy provenance/version id ----
    it('10+11 — activation copies the resolved values AND the provenance/version id into the snapshot', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const v = await terms.create(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, guarantee_duration_days: 365, remedy_policy: 'REFUND', guarantee_exposure_amount: '50000.00', currency: 'USD', source_type: 'IMPORTED', source_reference: 'batch-1', source_version: 'v1' }), 'c');
      const id = await startPermanentStored(input, '2026-06-01');
      const pp = (await rawPermanent(input.tenant_id, id))!;
      expect(pp.lifecycle_state).toBe('GUARANTEE_ACTIVE');
      expect(pp.guarantee_start_date.toISOString().slice(0, 10)).toBe('2026-06-01');
      expect(pp.guarantee_end_date.toISOString().slice(0, 10)).toBe(isoAddDays('2026-06-01', 365));
      expect(pp.guarantee_duration_days).toBe(365);
      expect(pp.remedy_policy).toBe('REFUND');
      expect(pp.guarantee_exposure_amount.toFixed(2)).toBe('50000.00');
      expect(pp.guarantee_exposure_currency).toBe('USD');
      // Provenance copied (11).
      expect(pp.guarantee_term_version_id).toBe(v.id);
      expect(pp.guarantee_terms_source_type).toBe('IMPORTED');
      expect(pp.guarantee_terms_source_reference).toBe('batch-1');
      expect(pp.guarantee_terms_source_version).toBe('v1');
    });

    // ---- 12. later revision does NOT change an existing snapshot ----
    it('12 — revising the terms after activation does not change the existing PermanentPlacement snapshot', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const v = await terms.create(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, guarantee_exposure_amount: '50000.00', guarantee_duration_days: 365 }), 'c');
      const id = await startPermanentStored(input, '2026-06-01');
      // Revise to entirely different terms.
      await terms.revise(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, effective_from: isoAddDays(todayUtcIso(), 30), guarantee_exposure_amount: '99999.00', guarantee_duration_days: 180, remedy_policy: 'REPLACEMENT' }), 'r');
      const pp = (await rawPermanent(input.tenant_id, id))!;
      expect(pp.guarantee_term_version_id).toBe(v.id);
      expect(pp.guarantee_exposure_amount.toFixed(2)).toBe('50000.00');
      expect(pp.guarantee_duration_days).toBe(365);
    });

    // ---- 13. P2 remedy remains snapshot-only ----
    it('13 — P2 remedy computes from the immutable snapshot, never the (later-revised) mutable terms', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      await terms.create(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, remedy_policy: 'REFUND', guarantee_exposure_amount: '50000.00' }), 'c');
      const id = await startPermanentStored(input, '2026-06-01');
      // Revise the reusable terms to a different exposure AFTER activation.
      await terms.revise(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, effective_from: isoAddDays(todayUtcIso(), 30), guarantee_exposure_amount: '12345.00' }), 'r');
      const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-07-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      // The remedy uses the SNAPSHOT exposure (50000), not the revised term (12345).
      expect(v.remedy?.calculated_amount).toBe('50000.00');
    });

    // ---- 14. legacy path (no stored version + explicit P1 input) ----
    it('14 — no stored version + legacy explicit guarantee_terms remains compatible (null provenance)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: legacyGuarantee(), recorded_by: randomUUID() }, 's');
      const pp = (await rawPermanent(input.tenant_id, id))!;
      expect(pp.lifecycle_state).toBe('GUARANTEE_ACTIVE');
      expect(pp.guarantee_term_version_id).toBeNull();
      expect(pp.guarantee_terms_source_type).toBeNull();
      expect(pp.terms_source).toBe('legacy_explicit');
    });

    // ---- 15. no stored + no explicit input fails closed ----
    it('15 — no stored version + no explicit terms fails closed (TERMS_NOT_FOUND 404); nothing materialises', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_start_date: '2026-06-01', recorded_by: randomUUID() }, 's'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_NOT_FOUND', statusCode: 404 });
      expect(await rawPermanent(input.tenant_id, id)).toBeNull();
    });

    // ---- 16. stored + conflicting explicit input rejects ----
    it('16 — a stored version plus conflicting explicit terms is rejected', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      await terms.create(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, guarantee_duration_days: 365 }), 'c');
      const id = await driveToReady(input);
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: legacyGuarantee({ guarantee_duration_days: 180 }), recorded_by: randomUUID() },
          's',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await rawPermanent(input.tenant_id, id)).toBeNull();
    });

    // ---- 18. tenant isolation ----
    it('18 — resolution is tenant-isolated (another tenant sees nothing)', async () => {
      const req = randomUUID();
      const tenantA = randomUUID(); const tenantB = randomUUID();
      await terms.create(termsInput({ tenant_id: tenantA, requisition_id: req }), 'c');
      expect(await terms.listVersions(tenantB, req)).toHaveLength(0);
      await expect(
        terms.getEffective(tenantB, req, new Date('2026-06-01T00:00:00.000Z'), 'e'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_NOT_FOUND', statusCode: 404 });
    });

    // ---- 19. normal DELETE blocked + 20. governed reset escape ----
    it('19+20 — a normal DELETE is append-only-blocked; the exact tenant_reset escape permits governed cleanup', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const v = await terms.create(termsInput({ tenant_id: tenant, requisition_id: req }), 'c');
      await expect(prisma.permanentPlacementGuaranteeTermVersion.delete({ where: { id: v.id } })).rejects.toBeTruthy();
      expect(await prisma.permanentPlacementGuaranteeTermVersion.count({ where: { id: v.id } })).toBe(1);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`DELETE FROM placement."PermanentPlacementGuaranteeTermVersion" WHERE id = '${v.id}'`);
      });
      expect(await prisma.permanentPlacementGuaranteeTermVersion.count({ where: { id: v.id } })).toBe(0);
    });

    // ---- 17. ambiguity fails closed (defensive; exercised by lifting the exclusion) ----
    it('17 — more than one effective version fails closed (TERMS_AMBIGUOUS 500)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      await prisma.$executeRawUnsafe('ALTER TABLE placement."PermanentPlacementGuaranteeTermVersion" DROP CONSTRAINT "ppgtv_no_window_overlap_excl"');
      const ids: string[] = [];
      try {
        // Distinct effective_from (the unique index still stands) but both OPEN and covering
        // the as_of -> two effective versions once the exclusion is lifted.
        for (const from of ['2026-01-01', '2026-02-01']) {
          const gid = randomUUID(); ids.push(gid);
          await prisma.$executeRawUnsafe(
            `INSERT INTO placement."PermanentPlacementGuaranteeTermVersion" (id, tenant_id, requisition_id, effective_from, effective_to, guarantee_duration_days, remedy_policy, guarantee_exposure_amount, currency, source_type, recorded_by, recorded_at, created_at) ` +
              `VALUES ('${gid}','${tenant}','${req}','${from}', NULL, 365, 'REFUND', 50000, 'USD', 'MANUAL', '${randomUUID()}', now(), now())`,
          );
        }
        await expect(
          terms.getEffective(tenant, req, new Date('2026-06-01T00:00:00.000Z'), 'e'),
        ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_AMBIGUOUS', statusCode: 500 });
      } finally {
        // Clean the injected rows via the governed reset escape, then restore the invariant.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
          for (const gid of ids) await tx.$executeRawUnsafe(`DELETE FROM placement."PermanentPlacementGuaranteeTermVersion" WHERE id = '${gid}'`);
        });
        await prisma.$executeRawUnsafe(EXCLUDE_CONSTRAINT_DDL);
      }
    });

    // ---- 21. contract placement regression ----
    it('21 — a CONTRACT placement still starts a ContractAssignment (no PermanentPlacement, no terms)', async () => {
      const input = baseInput({ placement_kind: 'CONTRACT' });
      const id = await driveToReady(input);
      await repo.transition(
        {
          tenant_id: input.tenant_id,
          placement_process_id: id,
          to: 'STARTED',
          assignment_context: { company_id: randomUUID() },
          commercial_terms: { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' },
          recorded_by: randomUUID(),
        },
        's',
      );
      expect(await rawPermanent(input.tenant_id, id)).toBeNull();
      expect(await prisma.contractAssignment.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(1);
    });

    // ---- 22. P1 satisfaction regression (stored-terms activation still satisfies) ----
    it('22 — a stored-terms permanent placement satisfies on/after the guarantee end date', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      await terms.create(termsInput({ tenant_id: input.tenant_id, requisition_id: input.requisition_id, effective_from: '2020-01-01', guarantee_duration_days: 1 }), 'c');
      const id = await startPermanentStored(input, '2020-01-01');
      const v = await permanent.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 't');
      expect(v.lifecycle_state).toBe('GUARANTEE_SATISFIED');
    });

    // ---- 23. P2 falloff/remedy regression (legacy path unaffected) ----
    it('23 — the legacy falloff+remedy path is unchanged (REPLACEMENT -> REPLACEMENT_DUE)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: legacyGuarantee({ remedy_policy: 'REPLACEMENT' }), recorded_by: randomUUID() }, 's');
      const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-07-01', reason: 'CLIENT_TERMINATED_PERFORMANCE', recorded_by: randomUUID() }, 'f');
      expect(v.lifecycle_state).toBe('REPLACEMENT_DUE');
      expect(v.remedy?.remedy_type).toBe('REPLACEMENT');
    });

    // ---- 24. T6 commercial regression (ARV effective-window path independent) ----
    it('24 — the T6 commercial-revision path is independent of guarantee terms', async () => {
      const input = baseInput({ placement_kind: 'CONTRACT' });
      const id = await driveToReady(input);
      await repo.transition(
        {
          tenant_id: input.tenant_id,
          placement_process_id: id,
          to: 'STARTED',
          assignment_context: { company_id: randomUUID() },
          commercial_terms: { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' },
          recorded_by: randomUUID(),
        },
        's',
      );
      const assignment = (await prisma.contractAssignment.findFirst({ where: { tenant_id: input.tenant_id, placement_process_id: id } }))!;
      const versions = await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id } });
      expect(versions).toBe(1);
    });
  },
);
