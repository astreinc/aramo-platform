import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { CapacityProjectionRepository } from '../lib/capacity/capacity-projection.repository.js';
import { deriveCapacity } from '../lib/capacity/capacity-derivation.js';
import type { CreatePlacementInput } from '../lib/placement-process.types.js';
import type { PlacementState } from '../lib/lifecycle/placement-lifecycle.js';

import { seedAcceptedOffer } from './support/offer-fixture.js';

// Track 4 / T4-A1 — ContractAssignment authority + persistence + the forward
// STARTED -> ContractAssignment path. Real Postgres 17. The migration set is the
// four pre-Track-4 placement migrations PLUS the T4-A1 additive contract
// assignment migration.
//
// Boundary proofs (Directive v1.0 §11):
//   - T4-A persistence: STARTED produces NO authoritative assignment today ->
//     exactly one persists after (non-vacuous: precondition 0, exact after 1).
//   - T4-A idempotency: a second assignment for the same start fact is refused.

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
  // Offer Lifecycle (D6) — the offer aggregate + the placement.offer_id column,
  // required by createPlacement's ACCEPTED-offer precondition.
  '20260824120000_init_offer_model',
  '20260901130000_offer_compensation_snapshot',
  '20260824130000_placement_offer_id',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// Track 5 / T5-P1 — a FORWARD STARTED transition now materialises the initial
// Assignment Rate Version in the same tx, so it requires the actual commercial
// terms + the recording principal. A shared valid fixture for the T4 STARTED paths.
const T5_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' } as const;

// Path from the birth state (now PRE_START, Offer Lifecycle D6) to READY_TO_START,
// then the START edge separately. Offer extension/acceptance now lives in the
// dedicated offer aggregate — the placement no longer births at OFFER_EXTENDED.
const PATH_TO_READY: PlacementState[] = ['READY_TO_START'];

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
  'ContractAssignment — T4-A1 forward path (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let capacity: CapacityProjectionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        const sql = readFileSync(path, 'utf8');
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
      capacity = new CapacityProjectionRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Offer Lifecycle (D6) — a placement is created from an ACCEPTED offer. Seed
    // one for the input's tenant and thread its id (the reusable seam; no
    // createPlacement bypass). Guard/E4 refusal tests still hit their earlier
    // checks first — the seeded offer is simply unused there.
    async function createValid(input: CreatePlacementInput, requestId: string) {
      const offer_id = input.offer_id ?? (await seedAcceptedOffer(prisma, { tenant_id: input.tenant_id }));
      return repo.createPlacement({ ...input, offer_id }, requestId);
    }

    async function driveToReady(input: CreatePlacementInput): Promise<string> {
      const created = await createValid(input, 'drive');
      let id = created.id;
      for (const to of PATH_TO_READY) {
        const v = await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'drive');
        id = v.id;
      }
      return id;
    }

    it('T4-A persistence: STARTED produces no assignment before, exactly one FORWARD/ACTIVE assignment after', async () => {
      const input = baseInput();
      const company_id = randomUUID();
      const id = await driveToReady(input);

      // PRECONDITION (non-vacuity): no authoritative assignment exists yet.
      const before = await prisma.contractAssignment.findMany({
        where: { tenant_id: input.tenant_id, placement_process_id: id },
      });
      expect(before).toHaveLength(0);

      // The START edge, with the caller-supplied org snapshot.
      const v = await repo.transition(
        {
          tenant_id: input.tenant_id,
          placement_process_id: id,
          to: 'STARTED',
          assignment_context: { company_id },
          commercial_terms: T5_TERMS,
          recorded_by: randomUUID(),
        },
        'start',
      );
      expect(v.state).toBe('STARTED');

      // EXACT after: exactly one authoritative assignment, FORWARD + ACTIVE, with
      // the start fact and the org snapshot.
      const after = await prisma.contractAssignment.findMany({
        where: { tenant_id: input.tenant_id, placement_process_id: id },
      });
      expect(after).toHaveLength(1);
      const a = after[0];
      expect(a.provenance).toBe('FORWARD');
      expect(a.lifecycle_state).toBe('ACTIVE');
      expect(a.submittal_id).toBe(input.submittal_id);
      expect(a.requisition_id).toBe(input.requisition_id);
      expect(a.talent_record_id).toBe(input.talent_record_id);
      expect(a.company_id).toBe(company_id);
      expect(a.started_at).toBeInstanceOf(Date);
    });

    it('T4-A idempotency: a duplicate assignment for the same start fact is refused', async () => {
      const input = baseInput();
      const company_id = randomUUID();
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
        'start',
      );

      // The unique (tenant_id, placement_process_id) index makes a second
      // materialisation of the same start fact impossible.
      await expect(
        prisma.contractAssignment.create({
          data: {
            id: randomUUID(),
            tenant_id: input.tenant_id,
            placement_process_id: id,
            submittal_id: input.submittal_id,
            requisition_id: input.requisition_id,
            talent_record_id: input.talent_record_id,
            started_at: new Date(),
            provenance: 'FORWARD',
            lifecycle_state: 'ACTIVE',
            company_id,
          },
        }),
      ).rejects.toThrow();

      const rows = await prisma.contractAssignment.findMany({
        where: { tenant_id: input.tenant_id, placement_process_id: id },
      });
      expect(rows).toHaveLength(1);
    });

    it('T4-B step 1b (CHARACTERIZATION): count/projection over ACTIVE assignments, tenant+requisition scoped', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const openings = 3;
      // Two placements (distinct submittals/talents) on the SAME requisition ->
      // two ACTIVE FORWARD assignments.
      for (let i = 0; i < 2; i++) {
        const input = baseInput({ tenant_id, requisition_id });
        const id = await driveToReady(input);
        await repo.transition(
          { tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
          'start',
        );
      }
      // A different requisition (same tenant) must NOT be counted for requisition_id.
      const other = baseInput({ tenant_id });
      const oid = await driveToReady(other);
      await repo.transition(
        { tenant_id, placement_process_id: oid, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
        'start',
      );

      const count = await capacity.countActiveByRequisition(tenant_id, requisition_id);
      expect(count).toBe(2);

      const proj = await capacity.projectCapacity(tenant_id, requisition_id, openings);
      expect(proj).toEqual(deriveCapacity({ openings, consuming_count: 2 }));
      expect(proj.capacity_balance).toBe(1);
      expect(proj.openings_available).toBe(1);
      expect(proj.capacity_status).toBe('AVAILABLE');
    });

    // ---- G2 boundaries (§3.4) — the assignment-aware guard + predicate split ----

    // Drive a fresh placement (fixed tenant+submittal) to STARTED, creating its
    // forward ACTIVE ContractAssignment; returns the placement id.
    async function startPlacement(tenant_id: string, submittal_id: string): Promise<string> {
      const input = baseInput({ tenant_id, submittal_id });
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() },
        'start',
      );
      return id;
    }

    it('B-assignment-active-blocks-replacement-attempt: STARTED + ACTIVE assignment refuses a second attempt', async () => {
      const tenant_id = randomUUID();
      const submittal_id = randomUUID();
      await startPlacement(tenant_id, submittal_id);
      // A second attempt on the same (tenant, submittal) while the assignment is
      // ACTIVE is refused — the guard is held.
      await expect(
        createValid(baseInput({ tenant_id, submittal_id }), 'second'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_ALREADY_LIVE' });
    });

    it('B-assignment-ended-releases-placement-guard: STARTED + ENDED assignment permits a later attempt', async () => {
      const tenant_id = randomUUID();
      const submittal_id = randomUUID();
      const first = await startPlacement(tenant_id, submittal_id);
      // End the assignment (ACTIVE -> ENDED) — releases the one-live guard.
      await repo.endAssignment({ tenant_id, placement_process_id: first, end_reason: 'WORKER_ENDED', ended_by: randomUUID() }, 'end');
      // A later attempt on the same (tenant, submittal) is now PERMITTED.
      const second = await createValid(baseInput({ tenant_id, submittal_id }), 'second');
      expect(second.state).toBe('PRE_START');
      expect(second.id).not.toBe(first);
    });

    it('B-e4-started-remains-ineligible: a STARTED predecessor whose assignment ENDED is STILL E4-ineligible', async () => {
      const tenant_id = randomUUID();
      const submittal_id = randomUUID();
      const started = await startPlacement(tenant_id, submittal_id);
      await repo.endAssignment({ tenant_id, placement_process_id: started, end_reason: 'CLIENT_ENDED', ended_by: randomUUID() }, 'end');
      // The guard is released (previous proof), but E4 replacement eligibility is a
      // SEPARATE predicate: STARTED is not in DUPLICATE_GUARD_INACTIVE, so pointing
      // replaces_placement_process_id at it is REFUSED (predecessor_not_terminal).
      // This is the proof Track 4 did NOT widen E4 as a side effect.
      const input = baseInput({ tenant_id, requisition_id: randomUUID(), replaces_placement_process_id: started });
      // same requisition as the predecessor (E4 checks tenant + requisition)
      const withSameReq = { ...input, requisition_id: (await repo.findById(tenant_id, started))!.requisition_id };
      await expect(createValid(withSameReq, 'e4')).rejects.toMatchObject({
        code: 'PLACEMENT_REPLACEMENT_INVALID',
        context: { details: { reason: 'predecessor_not_terminal' } },
      });
    });

    it('ending taxonomy: the three ratified categories are recorded structurally, and ENDED requires one', async () => {
      // Each ratified category is stored as the closed enum, not free text.
      for (const reason of ['COMPLETED', 'WORKER_ENDED', 'CLIENT_ENDED'] as const) {
        const tenant_id = randomUUID();
        const submittal_id = randomUUID();
        const id = await startPlacement(tenant_id, submittal_id);
        await repo.endAssignment({ tenant_id, placement_process_id: id, end_reason: reason, ended_by: randomUUID() }, 'end');
        const [row] = await prisma.contractAssignment.findMany({ where: { tenant_id, placement_process_id: id } });
        expect(row.lifecycle_state).toBe('ENDED');
        expect(row.end_reason).toBe(reason);
      }

      // The CHECK forbids an ENDED assignment with no reason (structural, not app-only).
      const tenant_id = randomUUID();
      const id = await startPlacement(tenant_id, randomUUID());
      await expect(
        prisma.contractAssignment.updateMany({
          where: { tenant_id, placement_process_id: id, lifecycle_state: 'ACTIVE' },
          data: { lifecycle_state: 'ENDED' }, // no end_reason
        }),
      ).rejects.toThrow();
    });

    it('T4-D audit/events: ending an assignment emits placement.assignment.ended atomically with the state flip', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const id = await startPlacement(tenant_id, randomUUID());
      // Rebind the started placement to a known requisition for payload assertion.
      // (startPlacement uses baseInput's random requisition; read it back.)
      const req = (await repo.findById(tenant_id, id))!.requisition_id;

      // PRECONDITION (non-vacuity): no ended-assignment event yet.
      const before = await prisma.outboxEvent.findMany({
        where: { tenant_id, event_type: 'placement.assignment.ended' },
      });
      expect(before).toHaveLength(0);

      await repo.endAssignment({ tenant_id, placement_process_id: id, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'end');

      // The state flip AND the event are both present (same transaction).
      const [row] = await prisma.contractAssignment.findMany({ where: { tenant_id, placement_process_id: id } });
      expect(row.lifecycle_state).toBe('ENDED');
      const events = await prisma.outboxEvent.findMany({
        where: { tenant_id, event_type: 'placement.assignment.ended' },
      });
      expect(events).toHaveLength(1);
      const payload = events[0].event_payload as Record<string, unknown>;
      expect(payload.placement_process_id).toBe(id);
      expect(payload.requisition_id).toBe(req);
      expect(payload.end_reason).toBe('COMPLETED');
    });

    // Slice #3 (LOCKED Aramo-Assignment-Extension v1.0) — extend the planned end
    // forward, derive ending_soon, stay capacity-neutral, with NO lifecycle flip.
    describe('Slice #3 — Assignment Extension / Ending Soon', () => {
      const DAY = 24 * 60 * 60 * 1000;
      const iso = (ms: number): string => new Date(Date.now() + ms).toISOString();
      const norm = (s: string): string => new Date(s).toISOString();

      it('first extend sets the horizon (previous null), appends history, updates the view, emits the event', async () => {
        const tenant_id = randomUUID();
        const id = await startPlacement(tenant_id, randomUUID());
        // PRECONDITION (non-vacuity): no horizon, no extension event yet.
        const before = await repo.findAssignmentByPlacement(tenant_id, id);
        expect(before!.expected_end_at).toBeNull();
        expect(before!.ending_soon).toBe(false);
        expect(
          await prisma.outboxEvent.findMany({ where: { tenant_id, event_type: 'placement.assignment.extended' } }),
        ).toHaveLength(0);

        const newEnd = iso(20 * DAY);
        const view = await repo.extendAssignment(
          { tenant_id, placement_process_id: id, new_expected_end_at: newEnd, reason: 'CLIENT_REQUEST', actor_id: randomUUID() },
          'extend',
        );
        expect(view.lifecycle_state).toBe('ACTIVE'); // NO state flip (R-EXTENSION-NOT-STATE)
        expect(norm(view.expected_end_at!)).toBe(norm(newEnd));
        expect(view.ending_soon).toBe(true); // 20d within the 30d horizon

        const ext = await prisma.assignmentExtension.findMany({ where: { tenant_id } });
        expect(ext).toHaveLength(1);
        expect(ext[0].previous_expected_end_at).toBeNull();
        expect(norm(ext[0].new_expected_end_at.toISOString())).toBe(norm(newEnd));
        expect(ext[0].reason).toBe('CLIENT_REQUEST');
        expect(ext[0].source).toBe('MANUAL');

        const events = await prisma.outboxEvent.findMany({ where: { tenant_id, event_type: 'placement.assignment.extended' } });
        expect(events).toHaveLength(1);
        expect((events[0].event_payload as Record<string, unknown>).placement_process_id).toBe(id);
      });

      it('forward-only: reject a new end that is not strictly forward (equal / earlier / past)', async () => {
        const tenant_id = randomUUID();
        const id = await startPlacement(tenant_id, randomUUID());
        await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: iso(30 * DAY), reason: 'RENEWAL', actor_id: randomUUID() }, 'x');
        // read back the EXACT stored horizon so the "equal" case is truly equal.
        const stored = (await repo.findAssignmentByPlacement(tenant_id, id))!.expected_end_at!;
        for (const bad of [stored, iso(10 * DAY), iso(-5 * DAY)]) {
          let err: { code?: string; statusCode?: number } | undefined;
          try {
            await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: bad, reason: 'RENEWAL', actor_id: randomUUID() }, 'x');
          } catch (e) { err = e as { code?: string; statusCode?: number }; }
          expect(err?.code).toBe('ASSIGNMENT_EXTENSION_NOT_FORWARD');
          expect(err?.statusCode).toBe(422);
        }
        // The refusals appended NO history (only the one successful extend).
        expect(await prisma.assignmentExtension.findMany({ where: { tenant_id } })).toHaveLength(1);
      });

      it('an ENDED assignment cannot be extended (only ACTIVE)', async () => {
        const tenant_id = randomUUID();
        const id = await startPlacement(tenant_id, randomUUID());
        await repo.endAssignment({ tenant_id, placement_process_id: id, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'end');
        let err: { code?: string } | undefined;
        try {
          await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: iso(40 * DAY), reason: 'RENEWAL', actor_id: randomUUID() }, 'x');
        } catch (e) { err = e as { code?: string }; }
        expect(err?.code).toBe('NOT_FOUND');
      });

      it('CAPACITY-NEUTRAL: extending an ACTIVE assignment does not change the derived consuming count', async () => {
        const tenant_id = randomUUID();
        const requisition_id = randomUUID();
        const input = baseInput({ tenant_id, requisition_id });
        const id = await driveToReady(input);
        await repo.transition({ tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() }, commercial_terms: T5_TERMS, recorded_by: randomUUID() }, 'start');
        const countBefore = await capacity.countActiveByRequisition(tenant_id, requisition_id);
        await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: iso(45 * DAY), reason: 'PROJECT_EXTENSION', actor_id: randomUUID() }, 'x');
        const countAfter = await capacity.countActiveByRequisition(tenant_id, requisition_id);
        expect(countAfter).toBe(countBefore); // ACTIVE stays ACTIVE — capacity input untouched
      });

      it('cross-tenant: a foreign tenant cannot extend the assignment (NOT_FOUND, no leak)', async () => {
        const tenant_id = randomUUID();
        const id = await startPlacement(tenant_id, randomUUID());
        let err: { code?: string } | undefined;
        try {
          await repo.extendAssignment({ tenant_id: randomUUID(), placement_process_id: id, new_expected_end_at: iso(40 * DAY), reason: 'RENEWAL', actor_id: randomUUID() }, 'x');
        } catch (e) { err = e as { code?: string }; }
        expect(err?.code).toBe('NOT_FOUND');
        // The real tenant's assignment is untouched by the foreign attempt.
        expect((await repo.findAssignmentByPlacement(tenant_id, id))!.expected_end_at).toBeNull();
      });

      it('ending_soon derivation: within 30d true, beyond 30d false (never stored)', async () => {
        const tenant_id = randomUUID();
        const id = await startPlacement(tenant_id, randomUUID());
        await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: iso(10 * DAY), reason: 'CLIENT_REQUEST', actor_id: randomUUID() }, 'x');
        expect((await repo.findAssignmentByPlacement(tenant_id, id))!.ending_soon).toBe(true);
        await repo.extendAssignment({ tenant_id, placement_process_id: id, new_expected_end_at: iso(60 * DAY), reason: 'RENEWAL', actor_id: randomUUID() }, 'x');
        expect((await repo.findAssignmentByPlacement(tenant_id, id))!.ending_soon).toBe(false);
      });
    });
  },
);

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
