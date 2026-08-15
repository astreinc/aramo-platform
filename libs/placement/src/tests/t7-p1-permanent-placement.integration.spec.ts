import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PermanentPlacementRepository } from '../lib/permanent/permanent-placement.repository.js';
import { CapacityProjectionRepository } from '../lib/capacity/capacity-projection.repository.js';
import type { CreatePlacementInput, GuaranteeTermsInput } from '../lib/placement-process.types.js';
import type { PlacementState } from '../lib/lifecycle/placement-lifecycle.js';

// Track 7 / T7-P1 — PermanentPlacement substrate + happy-path guarantee lifecycle +
// derived-capacity union. Real Postgres 17. The migration set is the full placement
// chain PLUS the additive T7 migration. Boundary proofs (directive §13):
//   authentic behaviour flips (assert BEFORE existed + EXACT after):
//     - a PERMANENT start now materialises a PermanentPlacement, NOT a ContractAssignment;
//     - a consuming PermanentPlacement counts toward derived capacity (was uncounted).
//   new-capability proofs (no pre-T7 behaviour could fail — greenfield, §20):
//     - guarantee window validation, happy-path satisfy, snapshot immutability, PII-safe outbox.
//   characterization (preservation): the CONTRACT start path + pure-contract capacity + isolation.

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

const T5_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' } as const;

// An ELAPSED guarantee window (end date in the past) — satisfaction is allowed.
const ELAPSED_TERMS: GuaranteeTermsInput = {
  guarantee_start_date: '2020-01-01',
  guarantee_duration_days: 30, // end 2020-01-31 (past)
  remedy_policy: 'REFUND',
  exposure_amount: '50000.00',
  exposure_currency: 'USD',
  terms_source: 'client_contract_default',
};

// An ACTIVE (not-yet-elapsed) guarantee window (end date far future).
const ACTIVE_TERMS: GuaranteeTermsInput = {
  guarantee_start_date: '2020-01-01',
  guarantee_duration_days: 1_000_000, // end far in the future
  remedy_policy: 'PRORATED_CREDIT',
  exposure_amount: '90000.00',
  exposure_currency: 'GBP',
  terms_source: 'placement_owned',
};

const PATH_TO_READY: PlacementState[] = ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START'];

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

function baseInput(overrides: Partial<CreatePlacementInput> = {}): CreatePlacementInput {
  return {
    tenant_id: randomUUID(),
    submittal_id: randomUUID(),
    requisition_id: randomUUID(),
    talent_record_id: randomUUID(),
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PermanentPlacement — T7-P1 substrate / guarantee happy-path / capacity union (real Postgres 17)',
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
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
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

    async function driveToReady(input: CreatePlacementInput): Promise<string> {
      const created = await repo.createPlacement(input, 'drive');
      let id = created.id;
      for (const to of PATH_TO_READY) {
        const v = await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'drive');
        id = v.id;
      }
      return id;
    }

    async function startPermanent(
      input: CreatePlacementInput,
      guarantee_terms: GuaranteeTermsInput,
    ): Promise<string> {
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms, recorded_by: randomUUID() },
        'start-perm',
      );
      return id;
    }

    // ---- Branch flip: PERMANENT start materialises a PermanentPlacement, not a ContractAssignment ----
    it('PERMANENT start: no PermanentPlacement before, exactly one GUARANTEE_ACTIVE with the exact snapshot after; NO ContractAssignment/ARV (branch exclusivity)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);

      // PRECONDITION (non-vacuity): no permanent placement and no assignment yet.
      expect(await prisma.permanentPlacement.findMany({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toHaveLength(0);
      expect(await prisma.contractAssignment.findMany({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toHaveLength(0);

      const recorded_by = randomUUID();
      const v = await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: ELAPSED_TERMS, recorded_by },
        'start-perm',
      );
      expect(v.state).toBe('STARTED');

      // EXACT after: exactly one PermanentPlacement, GUARANTEE_ACTIVE, exact snapshot.
      const perms = await prisma.permanentPlacement.findMany({ where: { tenant_id: input.tenant_id, placement_process_id: id } });
      expect(perms).toHaveLength(1);
      const p = perms[0]!;
      expect(p.lifecycle_state).toBe('GUARANTEE_ACTIVE');
      expect(p.remedy_policy).toBe('REFUND');
      expect(p.guarantee_exposure_amount.toFixed(2)).toBe('50000.00');
      expect(p.guarantee_exposure_currency).toBe('USD');
      expect(p.guarantee_duration_days).toBe(30);
      expect(p.recorded_by).toBe(recorded_by);
      expect(p.terms_source).toBe('client_contract_default');
      // Derived half-open end = start + duration (2020-01-01 + 30 = 2020-01-31).
      expect(p.guarantee_start_date.toISOString().slice(0, 10)).toBe('2020-01-01');
      expect(p.guarantee_end_date.toISOString().slice(0, 10)).toBe('2020-01-31');

      // Branch exclusivity: NO ContractAssignment and NO AssignmentRateVersion.
      expect(await prisma.contractAssignment.findMany({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toHaveLength(0);
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id, requisition_id: input.requisition_id } })).toBe(0);
    });

    // ---- Characterization: the CONTRACT path is unchanged ----
    it('CONTRACT start (explicit): materialises a ContractAssignment + ARV and NO PermanentPlacement', async () => {
      const input = baseInput({ placement_kind: 'CONTRACT' });
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
        'start-contract',
      );
      expect(await prisma.contractAssignment.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(1);
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id, requisition_id: input.requisition_id } })).toBe(1);
      expect(await prisma.permanentPlacement.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(0);
    });

    it('legacy NULL kind start: preserves historical CONTRACT behaviour (ContractAssignment, no PermanentPlacement)', async () => {
      const input = baseInput(); // placement_kind omitted -> NULL
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
        'start-null',
      );
      expect(await prisma.contractAssignment.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(1);
      expect(await prisma.permanentPlacement.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(0);
    });

    // ---- Guarantee window validation + fail-closed rollback (zero mutation) ----
    it('invalid duration (0) is rejected PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID and leaves ZERO partial state', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: { ...ELAPSED_TERMS, guarantee_duration_days: 0 }, recorded_by: randomUUID() },
          'bad-dur',
        ),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID', statusCode: 422 });

      // Fail-closed BEFORE the tx: no permanent placement, no event, no outbox, and the
      // placement state did NOT advance to STARTED.
      expect(await prisma.permanentPlacement.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(0);
      expect(await prisma.permanentPlacementEvent.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
      const still = await repo.findById(input.tenant_id, id);
      expect(still?.state).toBe('READY_TO_START');
    });

    it('absent guarantee terms on a PERMANENT start is PERMANENT_PLACEMENT_TERMS_REQUIRED (422)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', recorded_by: randomUUID() }, 'no-terms'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_REQUIRED', statusCode: 422 });
    });

    it('invalid exposure currency is PERMANENT_PLACEMENT_EXPOSURE_INVALID (422)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await driveToReady(input);
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: { ...ELAPSED_TERMS, exposure_currency: 'ZZZ' }, recorded_by: randomUUID() },
          'bad-cur',
        ),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_EXPOSURE_INVALID', statusCode: 422 });
    });

    it('guarantee_terms on a CONTRACT start is rejected (VALIDATION_ERROR) — fail-closed branch discipline', async () => {
      const input = baseInput({ placement_kind: 'CONTRACT' });
      const id = await driveToReady(input);
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, guarantee_terms: ELAPSED_TERMS, recorded_by: randomUUID() },
          'mixed',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    // ---- Capacity union: a consuming PermanentPlacement counts toward derived capacity ----
    it('capacity union: a GUARANTEE_ACTIVE permanent placement consumes one opening (before 0, after 1); a satisfied one keeps consuming', async () => {
      const tenant = randomUUID();
      const requisition = randomUUID();
      const input = baseInput({ tenant_id: tenant, requisition_id: requisition, placement_kind: 'PERMANENT' });

      // BEFORE (non-vacuity): the requisition has zero consuming records.
      const before = await capacity.projectCapacity(tenant, requisition, 3);
      expect(before.openings).toBe(3);
      expect(before.capacity_balance).toBe(3); // consuming_count 0

      const id = await startPermanent(input, ELAPSED_TERMS);
      // AFTER: exactly one consumed (the GUARANTEE_ACTIVE permanent placement).
      const active = await capacity.projectCapacity(tenant, requisition, 3);
      expect(active.capacity_balance).toBe(2); // consuming_count 1
      expect(active.openings_available).toBe(2);

      // A satisfied permanent placement CONTINUES to consume (the seat is filled).
      await permanent.transition({ tenant_id: tenant, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'satisfy');
      const satisfied = await capacity.projectCapacity(tenant, requisition, 3);
      expect(satisfied.capacity_balance).toBe(2); // still consuming_count 1
    });

    it('capacity union: contract + permanent on one requisition both consume (set-oriented count too)', async () => {
      const tenant = randomUUID();
      const requisition = randomUUID();

      const contract = baseInput({ tenant_id: tenant, requisition_id: requisition, placement_kind: 'CONTRACT' });
      const cid = await driveToReady(contract);
      await repo.transition({ tenant_id: tenant, placement_process_id: cid, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() }, 'c');

      const perm = baseInput({ tenant_id: tenant, requisition_id: requisition, placement_kind: 'PERMANENT' });
      await startPermanent(perm, ELAPSED_TERMS);

      const proj = await capacity.projectCapacity(tenant, requisition, 5);
      expect(proj.capacity_balance).toBe(3); // 5 - (1 contract + 1 permanent)

      const setMap = await capacity.countActiveByRequisitionIds(tenant, [requisition]);
      expect(setMap.get(requisition)).toBe(2);
    });

    it('pure-contract capacity is unchanged by T7 (characterization)', async () => {
      const tenant = randomUUID();
      const requisition = randomUUID();
      const contract = baseInput({ tenant_id: tenant, requisition_id: requisition, placement_kind: 'CONTRACT' });
      const cid = await driveToReady(contract);
      await repo.transition({ tenant_id: tenant, placement_process_id: cid, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() }, 'c');
      const proj = await capacity.projectCapacity(tenant, requisition, 2);
      expect(proj.capacity_balance).toBe(1); // 2 - 1 contract, no permanent involvement
    });

    // ---- Happy-path lifecycle GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED ----
    it('satisfy on/after end date advances to GUARANTEE_SATISFIED and appends event + outbox', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);

      const v = await permanent.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'satisfy');
      expect(v.lifecycle_state).toBe('GUARANTEE_SATISFIED');

      const events = await prisma.permanentPlacementEvent.findMany({ where: { tenant_id: input.tenant_id }, orderBy: { created_at: 'asc' } });
      expect(events.map((e) => (e.event_payload as { to: string }).to)).toEqual(['GUARANTEE_ACTIVE', 'GUARANTEE_SATISFIED']);
    });

    it('premature satisfy (window not elapsed) is PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ACTIVE_TERMS);
      await expect(
        permanent.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'early'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID', statusCode: 422 });
    });

    it('a second satisfy is an illegal transition PERMANENT_PLACEMENT_STATE_INVALID (422)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);
      await permanent.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'once');
      await expect(
        permanent.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'twice'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_STATE_INVALID', statusCode: 422 });
    });

    it('transition on a placement with no PermanentPlacement is PERMANENT_PLACEMENT_NOT_FOUND (404)', async () => {
      await expect(
        permanent.transition({ tenant_id: randomUUID(), placement_process_id: randomUUID(), to: 'GUARANTEE_SATISFIED' }, 'missing'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_NOT_FOUND', statusCode: 404 });
    });

    // ---- Idempotency + branch exclusivity ----
    it('idempotent replay: a second STARTED transition is refused (illegal edge) — no duplicate PermanentPlacement', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', guarantee_terms: ELAPSED_TERMS, recorded_by: randomUUID() }, 'replay'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_STATE_INVALID' });
      expect(await prisma.permanentPlacement.count({ where: { tenant_id: input.tenant_id, placement_process_id: id } })).toBe(1);
    });

    it('the guarantee snapshot is immutable at the DB layer (a snapshot-column UPDATE is rejected)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);
      const row = (await prisma.permanentPlacement.findFirst({ where: { tenant_id: input.tenant_id, placement_process_id: id } }))!;
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "placement"."PermanentPlacement" SET "guarantee_exposure_amount" = 1 WHERE "id" = '${row.id}'`),
      ).rejects.toBeTruthy();
    });

    // ---- Tenant isolation ----
    it('cross-tenant read/transition of a PermanentPlacement is not visible (null read / NOT_FOUND transition)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);
      const otherTenant = randomUUID();
      expect(await permanent.findByPlacement(otherTenant, id)).toBeNull();
      await expect(
        permanent.transition({ tenant_id: otherTenant, placement_process_id: id, to: 'GUARANTEE_SATISFIED' }, 'x-tenant'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_NOT_FOUND', statusCode: 404 });
    });

    // ---- Outbox is PII-safe ----
    it('the permanent-placement outbox events carry only IDs + governed facts (no PII, no free text)', async () => {
      const input = baseInput({ placement_kind: 'PERMANENT' });
      const id = await startPermanent(input, ELAPSED_TERMS);
      const events = await prisma.outboxEvent.findMany({
        where: { tenant_id: input.tenant_id, event_type: { in: ['permanent_placement.created', 'permanent_placement.guarantee_active'] } },
      });
      expect(events.length).toBe(2);
      const ALLOWED = new Set([
        'tenant_id', 'permanent_placement_id', 'placement_process_id', 'submittal_id', 'requisition_id',
        'talent_record_id', 'lifecycle_state', 'guarantee_start_date', 'guarantee_end_date', 'remedy_policy', 'occurred_at',
      ]);
      for (const e of events) {
        for (const k of Object.keys(e.event_payload as Record<string, unknown>)) {
          expect(ALLOWED.has(k)).toBe(true);
        }
        // No exposure amount / currency (withheld from the append-only outbox).
        expect(e.event_payload as Record<string, unknown>).not.toHaveProperty('guarantee_exposure_amount');
      }
    });
  },
);
