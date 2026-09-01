import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PermanentPlacementRepository } from '../lib/permanent/permanent-placement.repository.js';
import { CapacityProjectionRepository } from '../lib/capacity/capacity-projection.repository.js';
import { computeRemedyObligation } from '../lib/permanent/remedy-computation.js';
import type { CreatePlacementInput, GuaranteeTermsInput } from '../lib/placement-process.types.js';
import type { PlacementState, RemedyPolicy } from '../lib/lifecycle/placement-lifecycle.js';

import { seedAcceptedOffer } from './support/offer-fixture.js';

// Track 7 / T7-P2 — falloff + deterministic remedy + evidence completion. Real Postgres 17.
// The full placement chain PLUS the P1 and P2 additive migrations. Boundary proofs cover
// the directive §18 matrix (in/out-of-window falloff, deterministic mapping, refund/proration,
// half-up rounding, capacity release, evidence-gated completion, PII-safe outbox, reset escape).

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

const T5_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' } as const;
// Offer Lifecycle (D6) — born PRE_START (downstream of an ACCEPTED offer).
const PATH_TO_READY: PlacementState[] = ['READY_TO_START'];

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
function guaranteeTerms(policy: RemedyPolicy, over: Partial<GuaranteeTermsInput> = {}): GuaranteeTermsInput {
  return {
    guarantee_start_date: '2026-01-01',
    guarantee_duration_days: 365,
    remedy_policy: policy,
    exposure_amount: '50000.00',
    exposure_currency: 'USD',
    terms_source: 'client_contract_default',
    ...over,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PermanentPlacement — T7-P2 falloff + remedy (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let permanent: PermanentPlacementRepository;
    let capacity: CapacityProjectionRepository;

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
      capacity = new CapacityProjectionRepository(prisma);
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
    // Start a PERMANENT placement in GUARANTEE_ACTIVE with the given guarantee terms.
    async function startPermanent(input: CreatePlacementInput, terms: GuaranteeTermsInput): Promise<string> {
      const id = await driveToReady(input);
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: terms, recorded_by: randomUUID() }, 's');
      return id;
    }

    // ---- Falloff window (matrix 1-4) ----
    it('in-window falloff is accepted and lands directly in the deterministic remedy-due state', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      expect(v.lifecycle_state).toBe('REFUND_DUE');
      expect(v.falloff_reason).toBe('TALENT_RESIGNED');
      expect(v.falloff_effective_date?.toISOString().slice(0, 10)).toBe('2026-06-01');
      expect(v.remedy?.remedy_type).toBe('REFUND');
    });

    it('falloff on/after the guarantee end date, or before start, is FALLOFF_WINDOW_INVALID (422)', async () => {
      for (const bad of ['2027-01-01' /* == end (start+365) */, '2027-02-01' /* after */, '2025-12-31' /* before start */]) {
        const input = baseInput({ placement_kind: 'PERMANENT' });
        const id = await startPermanent(input, guaranteeTerms('REFUND'));
        await expect(
          permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: bad, reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f'),
        ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID', statusCode: 422 });
        // Fail-closed: state unchanged, no remedy, no falloff facts.
        expect((await permanent.findByPlacement(input.tenant_id, id))?.lifecycle_state).toBe('GUARANTEE_ACTIVE');
        expect(await prisma.permanentPlacementRemedy.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
      }
    });

    it('an ungoverned falloff reason is FALLOFF_REASON_INVALID (422)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await expect(
        permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'BECAUSE', recorded_by: randomUUID() }, 'f'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID', statusCode: 422 });
    });

    // ---- Deterministic remedy mapping (matrix 5) + event atomicity (6) + read (7) ----
    it('deterministic remedy mapping: REPLACEMENT->REPLACEMENT_DUE, REFUND->REFUND_DUE, PRORATED_CREDIT->PRORATED_CREDIT_DUE; FELL_OFF+due in one tx', async () => {
      const cases: Array<[RemedyPolicy, string]> = [['REPLACEMENT', 'REPLACEMENT_DUE'], ['REFUND', 'REFUND_DUE'], ['PRORATED_CREDIT', 'PRORATED_CREDIT_DUE']];
      for (const [policy, due] of cases) {
        const input = baseInput({ placement_kind: 'PERMANENT' });
        const id = await startPermanent(input, guaranteeTerms(policy));
        const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'MUTUAL_SEPARATION', recorded_by: randomUUID() }, 'f');
        expect(v.lifecycle_state).toBe(due);
        // Event history in one tx: activation, fell_off, remedy_due.
        const pp = (await prisma.permanentPlacement.findFirst({ where: { tenant_id: input.tenant_id, placement_process_id: id } }))!;
        const events = await prisma.permanentPlacementEvent.findMany({ where: { permanent_placement_id: pp.id }, orderBy: { created_at: 'asc' } });
        expect(events.map((e) => (e.event_payload as { to: string }).to)).toEqual(['GUARANTEE_ACTIVE', 'FELL_OFF', due]);
        // Read sees the due state.
        expect((await permanent.findByPlacement(input.tenant_id, id))?.lifecycle_state).toBe(due);
      }
    });

    // ---- Refund (8) + proration (9) + half-up boundary (10) ----
    it('refund_amount == guarantee_exposure_amount', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND', { exposure_amount: '50000.00' }));
      const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      expect(v.remedy?.calculated_amount).toBe('50000.00');
      expect(v.remedy?.currency).toBe('USD');
    });

    it('prorated credit follows the locked formula with half-up rounding to the currency minor unit', async () => {
      // exposure 100.00, duration 800, remaining_days 1 -> 100*1/800 = 0.125 -> half-up 0.13.
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const terms = guaranteeTerms('PRORATED_CREDIT', { exposure_amount: '100.00', guarantee_duration_days: 800 });
      const id = await startPermanent(input, terms);
      const end = isoAddDays('2026-01-01', 800);
      const falloff = isoAddDays(end, -1); // remaining_days = 1
      const v = await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: falloff, reason: 'JOB_ABANDONMENT', recorded_by: randomUUID() }, 'f');
      expect(v.remedy?.remaining_days).toBe(1);
      expect(v.remedy?.calculated_amount).toBe('0.13'); // half-up on 0.125
      // Pure-helper parity (zero / full / midpoint boundaries).
      const mk = (rem: number, dur = 800, exp = '100.00') =>
        computeRemedyObligation({ remedy_policy: 'PRORATED_CREDIT', exposure_amount: exp, exposure_currency: 'USD', guarantee_duration_days: dur, guarantee_end_date: new Date('2026-01-01T00:00:00Z'), falloff_effective_date: new Date('2026-01-01T00:00:00Z') });
      // zero remaining (falloff == end)
      expect(computeRemedyObligation({ remedy_policy: 'PRORATED_CREDIT', exposure_amount: '100.00', exposure_currency: 'USD', guarantee_duration_days: 800, guarantee_end_date: new Date('2026-01-01T00:00:00Z'), falloff_effective_date: new Date('2026-01-01T00:00:00Z') }).calculated_amount).toBe('0.00');
      // full remaining (falloff == start, remaining clamps to duration) -> full exposure
      expect(computeRemedyObligation({ remedy_policy: 'PRORATED_CREDIT', exposure_amount: '100.00', exposure_currency: 'USD', guarantee_duration_days: 800, guarantee_end_date: new Date('2028-03-11T00:00:00Z'), falloff_effective_date: new Date('2026-01-01T00:00:00Z') }).calculated_amount).toBe('100.00');
      void mk;
    });

    // ---- Capacity release (11) + remains released (12) ----
    it('capacity releases exactly on falloff and remains released through remedy-due and completed', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const input = baseInput({ tenant_id: tenant, requisition_id: req, placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      expect((await capacity.projectCapacity(tenant, req, 3)).capacity_balance).toBe(2); // consuming 1 (GUARANTEE_ACTIVE)
      await permanent.recordFalloff({ tenant_id: tenant, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      expect((await capacity.projectCapacity(tenant, req, 3)).capacity_balance).toBe(3); // released at falloff (REFUND_DUE non-consuming)
      await permanent.completeRemedy({ tenant_id: tenant, placement_process_id: id, external_reference: 'REF-1', completed_by: randomUUID() }, 'c');
      expect((await capacity.projectCapacity(tenant, req, 3)).capacity_balance).toBe(3); // still released (REMEDY_COMPLETED)
    });

    // ---- Replacement remedy: no auto-replacement (13), evidence checks (14-16), completion (15) ----
    it('REPLACEMENT completion requires a same-tenant/same-requisition PERMANENT placement that reached STARTED; creates no replacement; bad/cross-tenant evidence rejected', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const original = baseInput({ tenant_id: tenant, requisition_id: req, placement_kind: 'PERMANENT' });
      const oid = await startPermanent(original, guaranteeTerms('REPLACEMENT'));
      await permanent.recordFalloff({ tenant_id: tenant, placement_process_id: oid, effective_date: '2026-06-01', reason: 'CLIENT_TERMINATED_PERFORMANCE', recorded_by: randomUUID() }, 'f');

      // missing evidence -> REMEDY_INVALID
      await expect(permanent.completeRemedy({ tenant_id: tenant, placement_process_id: oid, completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });
      // an unknown replacement id -> REMEDY_INVALID (folds cross-tenant/not-found)
      await expect(permanent.completeRemedy({ tenant_id: tenant, placement_process_id: oid, replacement_placement_process_id: randomUUID(), completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });
      // a CONTRACT (wrong-kind) same-req STARTED placement -> rejected
      const wrongKind = baseInput({ tenant_id: tenant, requisition_id: req, placement_kind: 'CONTRACT' });
      const wkId = await driveToReady(wrongKind);
      await repo.transition({ tenant_id: tenant, placement_process_id: wkId, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() }, 'c');
      await expect(permanent.completeRemedy({ tenant_id: tenant, placement_process_id: oid, replacement_placement_process_id: wkId, completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });
      // external_reference not allowed for REPLACEMENT
      const rep = baseInput({ tenant_id: tenant, requisition_id: req, placement_kind: 'PERMANENT' });
      const repId = await startPermanent(rep, guaranteeTerms('REFUND'));
      await expect(permanent.completeRemedy({ tenant_id: tenant, placement_process_id: oid, replacement_placement_process_id: repId, external_reference: 'X', completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });

      // No auto-replacement: the count is captured AFTER all explicit placements exist,
      // right before completion, and must be UNCHANGED by the completion itself.
      const countBeforeComplete = await prisma.placementProcess.count({ where: { tenant_id: tenant } });
      // VALID: repId is a same-tenant/same-req PERMANENT placement that reached STARTED.
      const v = await permanent.completeRemedy({ tenant_id: tenant, placement_process_id: oid, replacement_placement_process_id: repId, completed_by: randomUUID() }, 'c');
      expect(v.lifecycle_state).toBe('REMEDY_COMPLETED');
      expect(v.remedy?.replacement_placement_process_id).toBe(repId);
      expect(v.remedy?.completion_reference).toBeNull();
      // Completion created NO replacement placement.
      expect(await prisma.placementProcess.count({ where: { tenant_id: tenant } })).toBe(countBeforeComplete);
    });

    // ---- Refund/credit evidence (17-19) ----
    it('REFUND/PRORATED_CREDIT require a bounded external reference; valid reference completes', async () => {
      for (const policy of ['REFUND', 'PRORATED_CREDIT'] as const) {
        const input = baseInput({ placement_kind: 'PERMANENT' });
        const id = await startPermanent(input, guaranteeTerms(policy));
        await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
        // missing reference -> REMEDY_INVALID
        await expect(permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });
        // replacement id not allowed for monetary remedy
        await expect(permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, replacement_placement_process_id: randomUUID(), completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_INVALID' });
        // valid
        const v = await permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, external_reference: '  SETTLE-42  ', completed_by: randomUUID() }, 'c');
        expect(v.lifecycle_state).toBe('REMEDY_COMPLETED');
        expect(v.remedy?.completion_reference).toBe('SETTLE-42'); // trimmed
        expect(v.remedy?.replacement_placement_process_id).toBeNull();
      }
    });

    // ---- Double completion (20) ----
    it('double completion is PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED (409)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      await permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, external_reference: 'R1', completed_by: randomUUID() }, 'c');
      await expect(permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, external_reference: 'R2', completed_by: randomUUID() }, 'c')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED', statusCode: 409 });
    });

    // ---- Tenant isolation (16) + double falloff ----
    it('cross-tenant falloff/completion returns not found; a second falloff is state-invalid', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await expect(permanent.recordFalloff({ tenant_id: randomUUID(), placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_NOT_FOUND', statusCode: 404 });
      await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      await expect(permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-07-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f')).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_STATE_INVALID' });
    });

    // ---- Outbox PII-safe + amount/reference absent (22-23) ----
    it('the falloff/remedy outbox events carry only governed facts — no PII, no amount, no completion reference', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      await permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, external_reference: 'SECRET-REF-123', completed_by: randomUUID() }, 'c');
      const evs = await prisma.outboxEvent.findMany({ where: { tenant_id: input.tenant_id, event_type: { in: ['permanent_placement.fell_off', 'permanent_placement.remedy_due', 'permanent_placement.remedy_completed'] } } });
      expect(evs.length).toBe(3);
      const ALLOWED = new Set(['tenant_id', 'permanent_placement_id', 'placement_process_id', 'requisition_id', 'talent_record_id', 'from_state', 'to_state', 'occurred_at', 'remedy_policy', 'falloff_effective_date', 'falloff_reason']);
      for (const e of evs) {
        const payload = e.event_payload as Record<string, unknown>;
        for (const k of Object.keys(payload)) expect(ALLOWED.has(k)).toBe(true);
        expect(payload).not.toHaveProperty('calculated_amount');
        expect(payload).not.toHaveProperty('completion_reference');
        expect(JSON.stringify(payload)).not.toContain('SECRET-REF-123');
      }
    });

    // ---- Regressions (24-26) ----
    it('P1 satisfaction path + pure-contract flow still work (characterization)', async () => {
      // P1 satisfy: an elapsed window can still be satisfied.
      const p = baseInput({ placement_kind: 'PERMANENT' });
      const pid = await startPermanent(p, guaranteeTerms('REFUND', { guarantee_start_date: '2020-01-01', guarantee_duration_days: 30 }));
      const sv = await permanent.transition({ tenant_id: p.tenant_id, placement_process_id: pid, to: 'GUARANTEE_SATISFIED' }, 't');
      expect(sv.lifecycle_state).toBe('GUARANTEE_SATISFIED');
      // Contract flow: STARTED -> ContractAssignment, no PermanentPlacement.
      const c = baseInput({ placement_kind: 'CONTRACT' });
      const cid = await driveToReady(c);
      await repo.transition({ tenant_id: c.tenant_id, placement_process_id: cid, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() }, 'c');
      expect(await prisma.contractAssignment.count({ where: { tenant_id: c.tenant_id, placement_process_id: cid } })).toBe(1);
      expect(await prisma.permanentPlacement.count({ where: { tenant_id: c.tenant_id, placement_process_id: cid } })).toBe(0);
    });

    // ---- Immutability + reset escape (21, 28) ----
    it('the remedy obligation is immutable + completion is write-once at the DB layer', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      const r = (await prisma.permanentPlacementRemedy.findFirst({ where: { tenant_id: input.tenant_id } }))!;
      // obligation facts immutable
      await expect(prisma.$executeRawUnsafe(`UPDATE "placement"."PermanentPlacementRemedy" SET "calculated_amount" = 1 WHERE "id" = '${r.id}'`)).rejects.toBeTruthy();
      // complete once
      await permanent.completeRemedy({ tenant_id: input.tenant_id, placement_process_id: id, external_reference: 'R', completed_by: randomUUID() }, 'c');
      // completion write-once (a second raw UPDATE of completion_reference rejected)
      await expect(prisma.$executeRawUnsafe(`UPDATE "placement"."PermanentPlacementRemedy" SET "completion_reference" = 'R2' WHERE "id" = '${r.id}'`)).rejects.toBeTruthy();
    });

    it('PermanentPlacementEvent + Remedy normal DELETE is blocked; the governed tenant-reset GUC escape works', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, guaranteeTerms('REFUND'));
      await permanent.recordFalloff({ tenant_id: input.tenant_id, placement_process_id: id, effective_date: '2026-06-01', reason: 'TALENT_RESIGNED', recorded_by: randomUUID() }, 'f');
      const pp = (await prisma.permanentPlacement.findFirst({ where: { tenant_id: input.tenant_id } }))!;
      // normal DELETE rejected
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "placement"."PermanentPlacementEvent" WHERE "permanent_placement_id" = '${pp.id}'`)).rejects.toBeTruthy();
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "placement"."PermanentPlacementRemedy" WHERE "permanent_placement_id" = '${pp.id}'`)).rejects.toBeTruthy();
      // governed tenant-reset escape (transaction-local GUC) succeeds
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`DELETE FROM "placement"."PermanentPlacementRemedy" WHERE "permanent_placement_id" = '${pp.id}'`);
        await tx.$executeRawUnsafe(`DELETE FROM "placement"."PermanentPlacementEvent" WHERE "permanent_placement_id" = '${pp.id}'`);
      });
      expect(await prisma.permanentPlacementEvent.count({ where: { permanent_placement_id: pp.id } })).toBe(0);
    });
  },
);
