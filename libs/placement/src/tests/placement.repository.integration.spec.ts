import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PlacementProcessEventRepository } from '../lib/placement-process-event.repository.js';
import { PlacementOutboxRepository } from '../lib/placement-outbox.repository.js';
import { LEGAL_TRANSITIONS, type PlacementState } from '../lib/lifecycle/placement-lifecycle.js';
import {
  PLACEMENT_REASONS,
  REASON_DETAIL_MAX,
  isGovernedTerminalTarget,
  type PlacementReasonDefinition,
} from '../lib/reasons/placement-reason-registry.js';
import type { CreatePlacementInput } from '../lib/placement-process.types.js';

// E3 — a transition into a governed terminal state now REQUIRES a reason. This
// helper returns a valid OPTIONAL reason code for a governed target (no detail
// needed) and {} for a non-governed target, so path-walking tests spread it on
// every hop unconditionally.
function reasonForTarget(target: PlacementState): { reason_code?: string } {
  if (!isGovernedTerminalTarget(target)) return {};
  const def = PLACEMENT_REASONS.find(
    (r) => r.status === 'active' && r.detailPolicy === 'OPTIONAL' && r.allowedTargets.includes(target),
  );
  return def ? { reason_code: def.code } : {};
}

// Track 4 / T4-A1 — a transition to STARTED materialises the forward
// ContractAssignment, whose FORWARD provenance requires a company snapshot. This
// helper supplies the caller-owned org context for a STARTED target and {} for
// every other target, so path-walking tests spread it on every hop.
// Track 5 / T5-P1 — a FORWARD STARTED transition now also requires the actual
// commercial terms + the recording principal (the initial Assignment Rate Version
// is materialised in the same tx). Non-STARTED targets carry neither.
function ctxForTarget(target: PlacementState): {
  assignment_context?: { company_id: string };
  commercial_terms?: { pay_rate_amount: string; bill_rate_amount: string; currency: string; rate_period: string };
  recorded_by?: string;
} {
  return target === 'STARTED'
    ? {
        assignment_context: { company_id: randomUUID() },
        commercial_terms: { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' },
        recorded_by: randomUUID(),
      }
    : {};
}

// Track 3 / E1-a — integration spec (real Postgres 17). One migration applies
// the whole placement schema (new schema, no cross-lib deps). Proves the
// directive tripwires end-to-end: the 14-edge BEFORE UPDATE matrix, the
// BEFORE INSERT one-live-attempt guard, event-log immutability, and tenant
// isolation. The migration SQL is a generated artifact; this exercises it.

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260803180000_init_placement_model/migration.sql',
);
// E1-c — the additive offer-snapshot + OutboxEvent migration, applied AFTER init.
const OFFER_OUTBOX_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260805120000_placement_offer_and_outbox/migration.sql',
);
// E3 — the additive fallthrough/terminal reason-evidence columns on
// PlacementProcessEvent (curated migration list: the Prisma client now selects
// these columns, so every placement-DB spec must apply this migration).
const REASON_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260807120000_placement_fallthrough_reason/migration.sql',
);
// E4 — the additive replacement-lineage column + self-reference CHECK on
// PlacementProcess (curated migration list: the Prisma client now selects
// replaces_placement_process_id, so every placement-DB spec must apply this).
const REPLACEMENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260808120000_placement_replacement_link/migration.sql',
);
// Track 4 / T4-A1 — the additive ContractAssignment table + forward-path enums.
// The Prisma client now knows ContractAssignment and the STARTED transition
// INSERTs into it, so every placement-DB spec that reaches STARTED must apply this.
const CONTRACT_ASSIGNMENT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260809120000_placement_contract_assignment/migration.sql',
);
// Track 4 / T4-C — ENDED lifecycle value + the assignment-aware one-live guard.
// The create() pre-check now queries lifecycle_state='ENDED', and the guard trigger
// is assignment-aware, so every placement-DB spec that creates placements must apply these.
const ASSIGNMENT_ENDED_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260810100000_placement_assignment_ended_value/migration.sql',
);
const ASSIGNMENT_GUARD_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260810110000_placement_assignment_aware_guard/migration.sql',
);
const ASSIGNMENT_END_REASON_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260810120000_placement_assignment_end_reason/migration.sql',
);
// Track 5 / T5-P1 — the additive AssignmentRateVersion table (curated migration
// list: the STARTED path now INSERTs the initial rate version, so every
// placement-DB spec that reaches STARTED must apply this).
const ASSIGNMENT_RATE_VERSION_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260810130000_t5_assignment_rate_version/migration.sql',
);

// Known transition path to reach each from-state from the initial
// OFFER_EXTENDED (the transitions to apply, in order).
const PATH_TO: Record<PlacementState, PlacementState[]> = {
  OFFER_EXTENDED: [],
  OFFER_ACCEPTED: ['OFFER_ACCEPTED'],
  PRE_START: ['OFFER_ACCEPTED', 'PRE_START'],
  BLOCKED: ['OFFER_ACCEPTED', 'PRE_START', 'BLOCKED'],
  READY_TO_START: ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START'],
  // terminal / engaged states are never a transition SOURCE in these paths
  STARTED: ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START', 'STARTED'],
  OFFER_DECLINED: ['OFFER_DECLINED'],
  OFFER_RESCINDED: ['OFFER_RESCINDED'],
  NO_SHOW: ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START', 'NO_SHOW'],
  FELL_THROUGH: ['OFFER_ACCEPTED', 'FELL_THROUGH'],
};

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
  'PlacementRepository — lifecycle + guards integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let events: PlacementProcessEventRepository;
    let outbox: PlacementOutboxRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      // Apply the init migration then the additive E1-c and E3 migrations, in order.
      for (const path of [INIT_MIGRATION_PATH, OFFER_OUTBOX_MIGRATION_PATH, REASON_MIGRATION_PATH, REPLACEMENT_MIGRATION_PATH, CONTRACT_ASSIGNMENT_MIGRATION_PATH, ASSIGNMENT_ENDED_MIGRATION_PATH, ASSIGNMENT_GUARD_MIGRATION_PATH, ASSIGNMENT_END_REASON_MIGRATION_PATH, ASSIGNMENT_RATE_VERSION_MIGRATION_PATH]) {
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
      events = new PlacementProcessEventRepository(prisma);
      outbox = new PlacementOutboxRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Drive a fresh placement (with the given input) to `state` via its known
    // path; returns its id. The caller owns the input, so it can keep
    // transitioning with the same tenant afterwards.
    async function driveTo(state: PlacementState, input: CreatePlacementInput): Promise<string> {
      const created = await repo.createPlacement(input, 'drive');
      let id = created.id;
      for (const to of PATH_TO[state]) {
        const v = await repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to, ...reasonForTarget(to), ...ctxForTarget(to) },
          'drive',
        );
        expect(v.state).toBe(to);
        id = v.id;
      }
      return id;
    }

    // ---- create ----

    it('creates a placement in the initial OFFER_EXTENDED state', async () => {
      const v = await repo.createPlacement(baseInput(), 'req-1');
      expect(v.state).toBe('OFFER_EXTENDED');
      expect(v.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    // ---- all 14 legal edges succeed at the DB layer ----

    it('permits all 14 legal edges (DB-level, via the repository)', async () => {
      for (const edge of LEGAL_TRANSITIONS) {
        const input = baseInput();
        const created = await repo.createPlacement(input, `edge-${edge.from}-${edge.to}`);
        let id = created.id;
        // drive to the edge's from-state
        for (const to of PATH_TO[edge.from]) {
          const v = await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'setup');
          id = v.id;
        }
        // exercise the edge (a governed terminal target now requires a reason)
        const moved = await repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: edge.to, ...reasonForTarget(edge.to), ...ctxForTarget(edge.to) },
          'edge',
        );
        expect(moved.state).toBe(edge.to);
      }
    });

    // ---- illegal edges rejected ----

    it('rejects the prohibited OFFER_ACCEPTED -> READY_TO_START edge (§4d, PLACEMENT_STATE_INVALID 422)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'acc');
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'a');
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'READY_TO_START' }, 'b'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_STATE_INVALID', statusCode: 422 });
    });

    it('rejects a representative illegal edge at the repository layer', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'ill');
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'STARTED' }, 'x'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_STATE_INVALID' });
    });

    it('the DB trigger rejects an illegal edge issued via raw SQL (defense-in-depth floor)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'raw');
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE placement."PlacementProcess" SET state = 'STARTED' WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/only the 14 legal state transitions/);
    });

    it('the DB trigger rejects a non-state column mutation (§8)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'colmut');
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE placement."PlacementProcess" SET tenant_id = '${randomUUID()}' WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/only the 14 legal state transitions/);
    });

    it('BLOCKED -> PRE_START succeeds (the only recovery edge)', async () => {
      const input = baseInput();
      const id = await driveTo('BLOCKED', input);
      const recovered = await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'PRE_START' },
        'rec',
      );
      expect(recovered.state).toBe('PRE_START');
    });

    // ---- PRE_START is traversed and recorded (§4d) ----

    it('PRE_START -> READY_TO_START succeeds with no requirements AND records the traversal in the event log', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'trav');
      const tenant = input.tenant_id;
      await repo.transition({ tenant_id: tenant, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, '1');
      await repo.transition({ tenant_id: tenant, placement_process_id: created.id, to: 'PRE_START' }, '2');
      const ready = await repo.transition(
        { tenant_id: tenant, placement_process_id: created.id, to: 'READY_TO_START' },
        '3',
      );
      expect(ready.state).toBe('READY_TO_START');

      const log = await events.listEvents(tenant, created.id);
      // three transitions => three state_transition events, in order.
      expect(log.map((e) => e.event_payload)).toEqual([
        { from: 'OFFER_EXTENDED', to: 'OFFER_ACCEPTED' },
        { from: 'OFFER_ACCEPTED', to: 'PRE_START' },
        { from: 'PRE_START', to: 'READY_TO_START' },
      ]);
    });

    // ---- duplicate-live-attempt guard ----

    it('rejects a second LIVE placement for the same (tenant, submittal) — PLACEMENT_ALREADY_LIVE 409', async () => {
      const input = baseInput();
      await repo.createPlacement(input, 'first');
      await expect(repo.createPlacement(input, 'second')).rejects.toMatchObject({
        code: 'PLACEMENT_ALREADY_LIVE',
        statusCode: 409,
      });
    });

    it('the BEFORE INSERT trigger rejects a raw second live row (race-safe floor)', async () => {
      const input = baseInput();
      await repo.createPlacement(input, 'floor');
      await expect(
        setupClient.$executeRawUnsafe(
          `INSERT INTO placement."PlacementProcess" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state)
           VALUES ('${randomUUID()}', '${input.tenant_id}', '${input.submittal_id}', '${input.requisition_id}', '${input.talent_record_id}', 'OFFER_EXTENDED')`,
        ),
      ).rejects.toThrow(/at most one live attempt/);
    });

    // The re-offer workflow — FOUR cases, one per DUPLICATE_GUARD_INACTIVE state.
    for (const terminal of ['OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH'] as const) {
      it(`permits a second attempt after the first reaches ${terminal} (re-offer, §8)`, async () => {
        const shared = { submittal_id: randomUUID(), tenant_id: randomUUID() };
        const input = baseInput(shared);
        const created = await repo.createPlacement(input, `re-${terminal}-a`);
        for (const to of PATH_TO[terminal]) {
          await repo.transition(
            { tenant_id: shared.tenant_id, placement_process_id: created.id, to, ...reasonForTarget(to) },
            'walk',
          );
        }
        // first attempt is now terminal — a second attempt is permitted.
        const second = await repo.createPlacement(baseInput(shared), `re-${terminal}-b`);
        expect(second.state).toBe('OFFER_EXTENDED');
        expect(second.id).not.toBe(created.id);
      });
    }

    it('rejects a second attempt while the first is STARTED (STARTED is ENGAGED, still live — §5/§8)', async () => {
      const shared = { submittal_id: randomUUID(), tenant_id: randomUUID() };
      const input = baseInput(shared);
      const created = await repo.createPlacement(input, 'started-a');
      for (const to of PATH_TO.STARTED) {
        await repo.transition({ tenant_id: shared.tenant_id, placement_process_id: created.id, to, ...ctxForTarget(to) }, 'walk');
      }
      await expect(repo.createPlacement(baseInput(shared), 'started-b')).rejects.toMatchObject({
        code: 'PLACEMENT_ALREADY_LIVE',
      });
    });

    // ---- event-log immutability ----

    it('the event log rejects UPDATE and DELETE at the database layer (§3)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'evt');
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'e');
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM placement."PlacementProcessEvent" WHERE placement_process_id = $1 LIMIT 1`,
        created.id,
      );
      const eventId = rows[0].id;
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE placement."PlacementProcessEvent" SET event_type = 'state_transition' WHERE id = '${eventId}'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM placement."PlacementProcessEvent" WHERE id = '${eventId}'`),
      ).rejects.toThrow(/immutable/);
    });

    // ---- tenant isolation ----

    it('reads are tenant-isolated', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'iso');
      expect(await repo.findById(input.tenant_id, created.id)).not.toBeNull();
      expect(await repo.findById(randomUUID(), created.id)).toBeNull();
      // events for the wrong tenant are not visible.
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 't');
      expect((await events.listEvents(randomUUID(), created.id)).length).toBe(0);
    });

    it('different submittals for the same tenant are independent (both may be live)', async () => {
      const tenant = randomUUID();
      const a = await repo.createPlacement(baseInput({ tenant_id: tenant }), 'sA');
      const b = await repo.createPlacement(baseInput({ tenant_id: tenant }), 'sB');
      expect(a.state).toBe('OFFER_EXTENDED');
      expect(b.state).toBe('OFFER_EXTENDED');
      expect(a.id).not.toBe(b.id);
    });

    // ================= E1-c — offer snapshot + transactional outbox =============

    // Raw read of the placement outbox rows for one aggregate, oldest first.
    async function outboxRowsFor(placementProcessId: string): Promise<
      Array<{ id: string; tenant_id: string; event_type: string; event_payload: Record<string, unknown>; published_at: Date | null }>
    > {
      return prisma.$queryRawUnsafe(
        `SELECT id, tenant_id, event_type, event_payload, published_at
           FROM placement."OutboxEvent"
          WHERE (event_payload->>'placement_process_id') = $1
          ORDER BY created_at ASC`,
        placementProcessId,
      );
    }

    // ---- proof 1: create persists the full offer snapshot ----

    it('create persists the initial offer snapshot (all offer columns round-trip)', async () => {
      const offered_at = new Date('2026-08-05T12:00:00.000Z');
      const proposed_start_date = new Date('2026-09-01T00:00:00.000Z');
      const offer_expires_at = new Date('2026-08-12T12:00:00.000Z');
      const input = baseInput({
        offered_at,
        proposed_start_date,
        offer_expires_at,
        client_offer_reference: 'CLIENT-REF-42',
        offer_terms_summary: 'Contract, 6 months, remote.',
      });
      const v = await repo.createPlacement(input, 'snap');
      expect(v.offered_at.toISOString()).toBe(offered_at.toISOString());
      expect(v.proposed_start_date?.toISOString()).toBe(proposed_start_date.toISOString());
      expect(v.offer_expires_at?.toISOString()).toBe(offer_expires_at.toISOString());
      expect(v.client_offer_reference).toBe('CLIENT-REF-42');
      expect(v.offer_terms_summary).toBe('Contract, 6 months, remote.');
      // Re-read confirms persistence (not just the projection of the write).
      const reread = await repo.findById(input.tenant_id, v.id);
      expect(reread?.client_offer_reference).toBe('CLIENT-REF-42');
    });

    it('create defaults offered_at to server time and leaves the optional offer fields null', async () => {
      const before = Date.now();
      const v = await repo.createPlacement(baseInput(), 'defaults');
      expect(v.offered_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(v.proposed_start_date).toBeNull();
      expect(v.offer_expires_at).toBeNull();
      expect(v.client_offer_reference).toBeNull();
      expect(v.offer_terms_summary).toBeNull();
    });

    it('the CHECK constraint rejects a raw offer_expires_at earlier than offered_at', async () => {
      await expect(
        setupClient.$executeRawUnsafe(
          `INSERT INTO placement."PlacementProcess"
             (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, offer_expires_at)
           VALUES ('${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}',
                   'OFFER_EXTENDED', '2026-08-05T12:00:00Z', '2026-08-04T12:00:00Z')`,
        ),
      ).rejects.toThrow(/offer_expiry_after_offered/);
    });

    // ---- proof 2 + 8: create commits EXACTLY ONE created event, snapshot in payload ----

    it('create commits exactly one placement.process.created outbox event carrying the snapshot', async () => {
      const offered_at = new Date('2026-08-05T09:30:00.000Z');
      // Supply offer_terms_summary so the assertion below genuinely proves it is
      // EXCLUDED from the event payload even when it is set on the aggregate.
      const input = baseInput({
        offered_at,
        client_offer_reference: 'REF-OUT',
        offer_terms_summary: 'SENSITIVE recruiter-authored free text — must not leak into the event',
        proposed_start_date: null,
        offer_expires_at: null,
      });
      const v = await repo.createPlacement(input, 'outc');
      const rows = await outboxRowsFor(v.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe('placement.process.created');
      expect(rows[0].published_at).toBeNull();
      expect(rows[0].tenant_id).toBe(input.tenant_id);
      const p = rows[0].event_payload;
      expect(p['placement_process_id']).toBe(v.id);
      expect(p['tenant_id']).toBe(input.tenant_id);
      expect(p['submittal_id']).toBe(input.submittal_id);
      expect(p['requisition_id']).toBe(input.requisition_id);
      expect(p['talent_record_id']).toBe(input.talent_record_id);
      expect(p['state']).toBe('OFFER_EXTENDED');
      expect(p['offered_at']).toBe(offered_at.toISOString());
      expect(p['proposed_start_date']).toBeNull();
      expect(p['offer_expires_at']).toBeNull();
      expect(p['client_offer_reference']).toBe('REF-OUT');
      expect(typeof p['occurred_at']).toBe('string');
      // PR-A regression guard — offer_terms_summary is DELIBERATELY ABSENT from the
      // created-event payload (recruiter free text must never enter the append-only,
      // non-reset-covered OutboxEvent). It stays on the aggregate.
      expect(Object.prototype.hasOwnProperty.call(p, 'offer_terms_summary')).toBe(false);
      expect(p['offer_terms_summary']).toBeUndefined();
      const reread = await repo.findById(input.tenant_id, v.id);
      expect(reread?.offer_terms_summary).toBe(input.offer_terms_summary);
    });

    // ---- proof 3: a rejected (duplicate-live) create writes NEITHER row nor event ----

    it('a rejected duplicate-live create writes no additional PlacementProcess row and no additional outbox event', async () => {
      const input = baseInput();
      const first = await repo.createPlacement(input, 'dup-1');
      await expect(repo.createPlacement(input, 'dup-2')).rejects.toMatchObject({ code: 'PLACEMENT_ALREADY_LIVE' });
      // Exactly one process row for the submittal, exactly one created event.
      const procRows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcess" WHERE submittal_id = '${input.submittal_id}'`,
      );
      expect(Number(procRows[0].count)).toBe(1);
      const outRows = await outboxRowsFor(first.id);
      expect(outRows).toHaveLength(1);
    });

    // ---- proof 4 (rollback / no residue): expiry-invalid create fails before the tx ----

    it('an offer_expires_at before offered_at is refused (VALIDATION_ERROR 400) and writes neither a row nor an outbox event', async () => {
      const offered_at = new Date('2026-08-05T12:00:00.000Z');
      const offer_expires_at = new Date('2026-08-04T12:00:00.000Z');
      const input = baseInput({ offered_at, offer_expires_at });
      await expect(repo.createPlacement(input, 'exp')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      });
      const procRows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcess" WHERE submittal_id = '${input.submittal_id}'`,
      );
      expect(Number(procRows[0].count)).toBe(0);
      const evRows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."OutboxEvent" WHERE tenant_id = '${input.tenant_id}'`,
      );
      expect(Number(evRows[0].count)).toBe(0);
    });

    // ---- proof 5 + 8: a transition commits EXACTLY ONE state_changed event ----

    it('a transition commits exactly one placement.process.state_changed event with from/to', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'tr');
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'tr2');
      const rows = await outboxRowsFor(created.id);
      // one created + one state_changed, in order.
      expect(rows.map((r) => r.event_type)).toEqual(['placement.process.created', 'placement.process.state_changed']);
      const changed = rows[1].event_payload;
      expect(changed['placement_process_id']).toBe(created.id);
      expect(changed['tenant_id']).toBe(input.tenant_id);
      expect(changed['submittal_id']).toBe(input.submittal_id);
      expect(changed['from_state']).toBe('OFFER_EXTENDED');
      expect(changed['to_state']).toBe('OFFER_ACCEPTED');
      expect(typeof changed['occurred_at']).toBe('string');
    });

    it('two transitions commit exactly two state_changed events (no duplicate emission)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'two');
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'a');
      await repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'PRE_START' }, 'b');
      const rows = await outboxRowsFor(created.id);
      const changed = rows.filter((r) => r.event_type === 'placement.process.state_changed');
      expect(changed).toHaveLength(2);
      expect(changed.map((r) => (r.event_payload as Record<string, unknown>)['to_state'])).toEqual(['OFFER_ACCEPTED', 'PRE_START']);
    });

    // ---- proof 6: an illegal transition emits NO state_changed event ----

    it('an illegal transition writes no state_changed outbox event (rejected before the tx)', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'ill-out');
      await expect(
        repo.transition({ tenant_id: input.tenant_id, placement_process_id: created.id, to: 'STARTED' }, 'x'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_STATE_INVALID' });
      const rows = await outboxRowsFor(created.id);
      // Only the created event exists; no state_changed was written.
      expect(rows.map((r) => r.event_type)).toEqual(['placement.process.created']);
    });

    // ---- proof 7: outbox events are tenant-scoped by their payload + column ----

    it('outbox events carry the aggregate tenant_id (isolation is by payload + column)', async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const a = await repo.createPlacement(baseInput({ tenant_id: tenantA }), 'iso-a');
      await repo.createPlacement(baseInput({ tenant_id: tenantB }), 'iso-b');
      const aRows = await outboxRowsFor(a.id);
      expect(aRows).toHaveLength(1);
      expect(aRows[0].tenant_id).toBe(tenantA);
      expect(aRows[0].tenant_id).not.toBe(tenantB);
    });

    // ---- proof 9: OutboxEvent is append-only; published_at is the only mutable column ----

    it('the OutboxEvent row rejects UPDATE of an immutable column and rejects DELETE, but permits the published_at drain', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'imm');
      const rows = await outboxRowsFor(created.id);
      const eventId = rows[0].id;

      // UPDATE of a non-published_at column → rejected.
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE placement."OutboxEvent" SET event_type = 'tampered' WHERE id = '${eventId}'`,
        ),
      ).rejects.toThrow(/append-only/);
      // DELETE → rejected.
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM placement."OutboxEvent" WHERE id = '${eventId}'`),
      ).rejects.toThrow(/append-only/);

      // published_at drain → permitted (the trigger allows published_at UPDATE).
      // findUnpublishedEvents returns rows oldest-first; assert the reader works
      // and, order-independently, that this row drains and the null-filter holds.
      expect((await outbox.findUnpublishedEvents({ limit: 1 })).length).toBe(1);
      expect(rows[0].published_at).toBeNull();
      const marked = await outbox.markPublished({ event_ids: [eventId], published_at: new Date() });
      expect(marked).toBe(1);
      const after = await outboxRowsFor(created.id);
      expect(after[0].published_at).not.toBeNull();
      // markPublished's published_at IS NULL filter excludes an already-drained row.
      const again = await outbox.markPublished({ event_ids: [eventId], published_at: new Date() });
      expect(again).toBe(0);
    });

    // ---- proof 11 (PR-A): mid-transaction outbox-insert failure rolls back the
    //      whole aggregate mutation. The failure is forced AT THE OUTBOX INSERT
    //      BOUNDARY (not pre-tx, not via unrelated validation) by a TEST-ONLY
    //      BEFORE INSERT trigger installed only inside this harness and dropped in
    //      guaranteed cleanup. The production immutability trigger is never touched.

    // Distinctive sentinel tenant IDs — the 'dead' hextet cannot collide with the
    // randomUUID() fixtures used everywhere else in this suite.
    const SENTINEL_CREATE = '00000000-dead-7000-8000-00000000000a';
    const SENTINEL_TRANSITION = '00000000-dead-7000-8000-00000000000b';
    // E3 — a third sentinel tenant for the reason-BEARING terminal-transition
    // rollback proof (Case C).
    const SENTINEL_REASON = '00000000-dead-7000-8000-00000000000c';
    // E3 corrective (§16) — a fourth sentinel tenant for the EVENT-INSERT-failure
    // rollback proof (Case D). Distinct injection point from Case A/B/C (which all
    // force the OutboxEvent insert): here the PlacementProcessEvent insert itself
    // fails, after the process-state update.
    const SENTINEL_EVENT_FAIL = '00000000-dead-7000-8000-00000000000d';

    // Install a BEFORE INSERT trigger that raises for exactly the three sentinel
    // (event_type, tenant) pairs — forcing the OutboxEvent insert (and only that
    // insert) to fail. Idempotent so the proofs are order-independent.
    async function installSentinelOutboxTrigger(): Promise<void> {
      await setupClient.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION placement.force_outbox_insert_fail()
         RETURNS TRIGGER AS $$
         BEGIN
           IF (NEW."event_type" = 'placement.process.created' AND NEW."tenant_id" = '${SENTINEL_CREATE}')
              OR (NEW."event_type" = 'placement.process.state_changed' AND NEW."tenant_id" IN ('${SENTINEL_TRANSITION}', '${SENTINEL_REASON}'))
           THEN
             RAISE EXCEPTION 'forced outbox insert failure (test sentinel)';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql;`,
      );
      await setupClient.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS trg_test_force_outbox_fail ON placement."OutboxEvent";`,
      );
      await setupClient.$executeRawUnsafe(
        `CREATE TRIGGER trg_test_force_outbox_fail
           BEFORE INSERT ON placement."OutboxEvent"
           FOR EACH ROW EXECUTE FUNCTION placement.force_outbox_insert_fail();`,
      );
    }

    async function dropSentinelOutboxTrigger(): Promise<void> {
      await setupClient.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS trg_test_force_outbox_fail ON placement."OutboxEvent";`,
      );
      await setupClient.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS placement.force_outbox_insert_fail();`,
      );
    }

    // Assert the production append-only triggers are present and unchanged.
    async function productionImmutabilityTriggers(): Promise<string[]> {
      const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'placement."OutboxEvent"'::regclass AND NOT tgisinternal
          ORDER BY tgname`,
      );
      return rows.map((r) => r.tgname);
    }

    async function countPlacementRows(tenantId: string): Promise<number> {
      const r = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcess" WHERE tenant_id = '${tenantId}'`,
      );
      return Number(r[0].count);
    }
    async function countOutboxRows(tenantId: string, eventType: string): Promise<number> {
      const r = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."OutboxEvent" WHERE tenant_id = '${tenantId}' AND event_type = '${eventType}'`,
      );
      return Number(r[0].count);
    }

    it('Case A — a create whose OutboxEvent insert fails at the boundary rolls back BOTH writes (no PlacementProcess, no OutboxEvent)', async () => {
      const before = await productionImmutabilityTriggers();
      expect(before).toEqual(['trg_reject_outbox_delete', 'trg_reject_outbox_update']);

      // Control: the same-shaped input under a NON-sentinel tenant succeeds and
      // writes both rows — proving the aggregate mutation is otherwise valid and
      // that the only difference is the forced outbox failure.
      const controlInput = baseInput({ client_offer_reference: 'CASE-A-CONTROL' });
      const control = await repo.createPlacement(controlInput, 'caseA-control');
      expect(await countPlacementRows(controlInput.tenant_id)).toBe(1);
      expect(await countOutboxRows(controlInput.tenant_id, 'placement.process.created')).toBe(1);

      await installSentinelOutboxTrigger();
      try {
        const input = baseInput({ tenant_id: SENTINEL_CREATE, client_offer_reference: 'CASE-A' });
        // The rejection must originate at the OUTBOX INSERT (sentinel message),
        // not from the pre-tx duplicate guard or offer validation.
        await expect(repo.createPlacement(input, 'caseA')).rejects.toThrow(
          /forced outbox insert failure \(test sentinel\)/,
        );
        // Both writes rolled back: no PlacementProcess row, no OutboxEvent row.
        expect(await countPlacementRows(SENTINEL_CREATE)).toBe(0);
        expect(await countOutboxRows(SENTINEL_CREATE, 'placement.process.created')).toBe(0);
      } finally {
        await dropSentinelOutboxTrigger();
      }

      // Production triggers remain present and unchanged; the control aggregate is
      // untouched by the rollback (no cross-tenant residue).
      expect(await productionImmutabilityTriggers()).toEqual(before);
      expect((await repo.findById(controlInput.tenant_id, control.id))?.state).toBe('OFFER_EXTENDED');
    });

    it('Case B — a transition whose OutboxEvent insert fails rolls back the state mutation + event, leaving the aggregate and its created row intact', async () => {
      const before = await productionImmutabilityTriggers();
      expect(before).toEqual(['trg_reject_outbox_delete', 'trg_reject_outbox_update']);

      // Create succeeds (the created event does NOT match the transition sentinel),
      // so an otherwise-valid aggregate exists before the forced transition failure.
      const input = baseInput({ tenant_id: SENTINEL_TRANSITION });
      const created = await repo.createPlacement(input, 'caseB-create');
      const stateBefore = created.state;
      expect(stateBefore).toBe('OFFER_EXTENDED');
      expect(await countOutboxRows(SENTINEL_TRANSITION, 'placement.process.created')).toBe(1);

      await installSentinelOutboxTrigger();
      try {
        // Legal transition; its state_changed outbox insert hits the sentinel.
        await expect(
          repo.transition({ tenant_id: SENTINEL_TRANSITION, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'caseB'),
        ).rejects.toThrow(/forced outbox insert failure \(test sentinel\)/);

        // State mutation rolled back — original state preserved.
        const reread = await repo.findById(SENTINEL_TRANSITION, created.id);
        expect(reread).not.toBeNull();
        expect(reread?.state).toBe(stateBefore);
        // No state_changed outbox row, and the PlacementProcessEvent append rolled back too.
        expect(await countOutboxRows(SENTINEL_TRANSITION, 'placement.process.state_changed')).toBe(0);
        expect((await events.listEvents(SENTINEL_TRANSITION, created.id)).length).toBe(0);
        // Distinguish "transition rolled back" from "whole aggregate disappeared":
        // the aggregate row still exists AND its earlier created event is intact.
        expect(await countPlacementRows(SENTINEL_TRANSITION)).toBe(1);
        expect(await countOutboxRows(SENTINEL_TRANSITION, 'placement.process.created')).toBe(1);
      } finally {
        await dropSentinelOutboxTrigger();
      }

      expect(await productionImmutabilityTriggers()).toEqual(before);
    });

    // ================= E3 — fallthrough/terminal reason evidence ===============
    // Proofs derive their reason fixtures FROM the registry (never hard-code a
    // business code), so a future PO re-ruling of the taxonomy is a data swap.

    const OPTIONAL_DEF: PlacementReasonDefinition = PLACEMENT_REASONS.find(
      (r) => r.status === 'active' && r.detailPolicy === 'OPTIONAL',
    )!;
    const REQUIRED_DEF: PlacementReasonDefinition = PLACEMENT_REASONS.find(
      (r) => r.status === 'active' && r.detailPolicy === 'REQUIRED',
    )!;
    const PROHIBITED_DEF: PlacementReasonDefinition = PLACEMENT_REASONS.find(
      (r) => r.status === 'active' && r.detailPolicy === 'PROHIBITED',
    )!;

    // Drive a fresh placement to a governed terminal `target`, applying the reason
    // ONLY on the final (governed) edge — intermediates carry no reason. Returns id.
    async function driveToTerminalWithReason(
      target: PlacementState,
      tenant: string,
      reason: { reason_code?: string | null; reason_detail?: string | null },
      overrides: Partial<CreatePlacementInput> = {},
    ): Promise<string> {
      const input = baseInput({ tenant_id: tenant, ...overrides });
      const created = await repo.createPlacement(input, 'e3-create');
      let id = created.id;
      const path = PATH_TO[target];
      for (let i = 0; i < path.length - 1; i++) {
        const v = await repo.transition({ tenant_id: tenant, placement_process_id: id, to: path[i]! }, 'e3-mid');
        id = v.id;
      }
      const final = await repo.transition(
        { tenant_id: tenant, placement_process_id: id, to: target, ...reason },
        'e3-final',
      );
      expect(final.state).toBe(target);
      return id;
    }

    // ---- §14.3-4 + §14.5/C1: valid reason persists on the event; outbox carries
    //      reason_code + reason_label_snapshot but NEVER reason_detail ----

    it('a valid reason persists reason_code + label snapshot + detail on the event, and the outbox carries code + label but NOT detail (C1)', async () => {
      const target = REQUIRED_DEF.allowedTargets[0]!; // REQUIRED code → detail present
      const tenant = randomUUID();
      const detail = 'the specific missing distinction, in the operator words';
      const id = await driveToTerminalWithReason(target, tenant, {
        reason_code: REQUIRED_DEF.code,
        reason_detail: detail,
      });

      // Event evidence: all three reason columns persisted (detail on the aggregate).
      const log = await events.listEvents(tenant, id);
      const terminalEvt = log[log.length - 1]!;
      expect(terminalEvt.reason_code).toBe(REQUIRED_DEF.code);
      expect(terminalEvt.reason_label_snapshot).toBe(REQUIRED_DEF.label);
      expect(terminalEvt.reason_detail).toBe(detail);

      // Outbox evidence: the state_changed row carries code + label + to_state, and
      // NO reason_detail under ANY key (C1 — the hard prohibition).
      const rows = await outboxRowsFor(id);
      const changed = rows.filter((r) => r.event_type === 'placement.process.state_changed');
      const payload = changed[changed.length - 1]!.event_payload;
      expect(payload['reason_code']).toBe(REQUIRED_DEF.code);
      expect(payload['reason_label_snapshot']).toBe(REQUIRED_DEF.label);
      expect(payload['to_state']).toBe(target);
      expect(Object.prototype.hasOwnProperty.call(payload, 'reason_detail')).toBe(false);
      expect(payload['reason_detail']).toBeUndefined();
      // And the detail text does not appear under any other payload key.
      expect(JSON.stringify(payload).includes(detail)).toBe(false);
    });

    // ---- §14.6-8: detail policy behaviour end-to-end ----

    it('OPTIONAL detail succeeds both present (persisted, normalised) and absent (null); outbox never carries detail', async () => {
      const target = OPTIONAL_DEF.allowedTargets[0]!;
      // Present.
      const withDetail = await driveToTerminalWithReason(target, randomUUID(), {
        reason_code: OPTIONAL_DEF.code,
        reason_detail: '  spaced   out  ',
      });
      const wLog = await events.listEvents(await tenantOf(withDetail), withDetail);
      expect(wLog[wLog.length - 1]!.reason_detail).toBe('spaced out');
      // Absent.
      const noDetail = await driveToTerminalWithReason(target, randomUUID(), { reason_code: OPTIONAL_DEF.code });
      const nLog = await events.listEvents(await tenantOf(noDetail), noDetail);
      expect(nLog[nLog.length - 1]!.reason_code).toBe(OPTIONAL_DEF.code);
      expect(nLog[nLog.length - 1]!.reason_detail).toBeNull();
    });

    it('REQUIRED detail succeeds with valid normalised input', async () => {
      const target = REQUIRED_DEF.allowedTargets[0]!;
      const tenant = randomUUID();
      const id = await driveToTerminalWithReason(target, tenant, {
        reason_code: REQUIRED_DEF.code,
        reason_detail: '   needs    text   ',
      });
      const log = await events.listEvents(tenant, id);
      expect(log[log.length - 1]!.reason_detail).toBe('needs text');
    });

    it('PROHIBITED detail succeeds only when absent, and persists a null detail (data-classification: the finding never lands here)', async () => {
      const target = PROHIBITED_DEF.allowedTargets[0]!;
      const tenant = randomUUID();
      const id = await driveToTerminalWithReason(target, tenant, { reason_code: PROHIBITED_DEF.code });
      const log = await events.listEvents(tenant, id);
      const evt = log[log.length - 1]!;
      expect(evt.reason_code).toBe(PROHIBITED_DEF.code);
      expect(evt.reason_label_snapshot).toBe(PROHIBITED_DEF.label);
      expect(evt.reason_detail).toBeNull();
    });

    // ---- §14.9: legacy / non-governed events read as null reason (not a code) ----

    it('a non-governed transition writes null reason evidence, and the read view reports null (legacy-null tolerance)', async () => {
      const tenant = randomUUID();
      const input = baseInput({ tenant_id: tenant });
      const created = await repo.createPlacement(input, 'e3-legacy');
      // OFFER_EXTENDED -> OFFER_ACCEPTED is non-governed; carries no reason.
      await repo.transition({ tenant_id: tenant, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'e3-ng');
      const log = await events.listEvents(tenant, created.id);
      expect(log).toHaveLength(1);
      expect(log[0]!.reason_code).toBeNull();
      expect(log[0]!.reason_label_snapshot).toBeNull();
      expect(log[0]!.reason_detail).toBeNull();
    });

    // ---- §15: negative proofs — every refusal is PLACEMENT_REASON_INVALID 422 and
    //      NON-VACUOUS (placement exists, edge exists, state/event/outbox unchanged) ----

    // Snapshot {state, event count, per-tenant outbox count} to prove non-vacuity.
    async function reasonSnapshot(tenant: string, id: string): Promise<{ state: string | null; events: number; outbox: number }> {
      const p = await prisma.placementProcess.findFirst({ where: { id, tenant_id: tenant } });
      const evCount = (await events.listEvents(tenant, id)).length;
      const r = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."OutboxEvent" WHERE tenant_id = '${tenant}'`,
      );
      return { state: p?.state ?? null, events: evCount, outbox: Number(r[0]!.count) };
    }

    // A governed terminal target reachable directly from OFFER_EXTENDED, and a
    // reason code NOT allowed for it (for the wrong-target proof).
    const GOV_TARGET = OPTIONAL_DEF.allowedTargets[0]!; // e.g. OFFER_DECLINED
    const WRONG_CODE = PLACEMENT_REASONS.find(
      (r) => r.status === 'active' && !r.allowedTargets.includes(GOV_TARGET),
    )!;

    type Case = { name: string; reason: { reason_code?: string | null; reason_detail?: string | null }; expect: string };
    const NEGATIVE_CASES: Case[] = [
      { name: 'governed target with no reason code', reason: {}, expect: 'reason_required' },
      { name: 'unknown reason code', reason: { reason_code: 'no_such_code_xyz' }, expect: 'reason_unknown' },
      { name: 'a label supplied instead of a code', reason: { reason_code: OPTIONAL_DEF.label }, expect: 'reason_unknown' },
      { name: 'a reason valid for a different target', reason: { reason_code: WRONG_CODE.code }, expect: 'reason_wrong_target' },
      { name: 'REQUIRED detail missing', reason: { reason_code: REQUIRED_DEF.code }, expect: 'detail_required' },
      { name: 'REQUIRED detail whitespace-only', reason: { reason_code: REQUIRED_DEF.code, reason_detail: '     ' }, expect: 'detail_required' },
      { name: 'PROHIBITED detail present', reason: { reason_code: PROHIBITED_DEF.code, reason_detail: 'a finding' }, expect: 'detail_prohibited' },
      { name: 'overlong detail', reason: { reason_code: OPTIONAL_DEF.code, reason_detail: 'x'.repeat(REASON_DETAIL_MAX + 1) }, expect: 'detail_too_long' },
    ];

    for (const c of NEGATIVE_CASES) {
      it(`rejects: ${c.name} → PLACEMENT_REASON_INVALID 422 (non-vacuous: state/event/outbox unchanged)`, async () => {
        const tenant = randomUUID();
        const created = await repo.createPlacement(baseInput({ tenant_id: tenant }), 'e3-neg');
        // For the PROHIBITED/wrong-target cases the target must accept the code's
        // policy shape; drive to that code's own governed target.
        const target =
          c.expect === 'detail_prohibited'
            ? PROHIBITED_DEF.allowedTargets[0]!
            : c.expect === 'detail_required'
              ? REQUIRED_DEF.allowedTargets[0]!
              : GOV_TARGET;
        // Drive intermediates (no reason) so the failing edge is the governed one
        // and the placement + edge genuinely exist (non-vacuity).
        let id = created.id;
        const path = PATH_TO[target];
        for (let i = 0; i < path.length - 1; i++) {
          const v = await repo.transition({ tenant_id: tenant, placement_process_id: id, to: path[i]! }, 'e3-neg-mid');
          id = v.id;
        }
        const before = await reasonSnapshot(tenant, id);
        await expect(
          repo.transition({ tenant_id: tenant, placement_process_id: id, to: target, ...c.reason }, 'e3-neg-final'),
        ).rejects.toMatchObject({ code: 'PLACEMENT_REASON_INVALID', statusCode: 422, context: { details: { reason: c.expect } } });
        // Non-vacuous: nothing moved — no state change, no event append, no outbox row.
        expect(await reasonSnapshot(tenant, id)).toEqual(before);
      });
    }

    it('rejects reason input supplied for a NON-governed transition → reason_on_non_governed_target (non-vacuous)', async () => {
      const tenant = randomUUID();
      const created = await repo.createPlacement(baseInput({ tenant_id: tenant }), 'e3-ng-neg');
      const before = await reasonSnapshot(tenant, created.id);
      await expect(
        repo.transition(
          { tenant_id: tenant, placement_process_id: created.id, to: 'OFFER_ACCEPTED', reason_code: OPTIONAL_DEF.code },
          'e3-ng-neg',
        ),
      ).rejects.toMatchObject({
        code: 'PLACEMENT_REASON_INVALID',
        statusCode: 422,
        context: { details: { reason: 'reason_on_non_governed_target' } },
      });
      expect(await reasonSnapshot(tenant, created.id)).toEqual(before);
    });

    // ---- §16: Case C — a reason-BEARING terminal transition whose outbox insert
    //      fails rolls back the state + the reason-bearing event + the outbox; no
    //      partial reason evidence remains ----

    it('Case C — a reason-bearing terminal transition whose OutboxEvent insert fails rolls back state + reason event + outbox (no partial reason evidence)', async () => {
      const before = await productionImmutabilityTriggers();
      expect(before).toEqual(['trg_reject_outbox_delete', 'trg_reject_outbox_update']);

      const target = REQUIRED_DEF.allowedTargets[0]!;
      const input = baseInput({ tenant_id: SENTINEL_REASON });
      const created = await repo.createPlacement(input, 'caseC-create');
      const stateBefore = created.state;
      // Drive any intermediates (non-sentinel event types don't match the trigger's
      // state_changed clause for this tenant... actually they DO — so terminal must
      // be directly reachable). Choose a target directly reachable from the current
      // state to keep the single failing edge governed.
      // OFFER_EXTENDED reaches OFFER_DECLINED / OFFER_RESCINDED directly; pick one
      // that REQUIRED_DEF is allowed for, else fall back to the code's own target.
      const directTarget: PlacementState = REQUIRED_DEF.allowedTargets.includes('OFFER_DECLINED')
        ? 'OFFER_DECLINED'
        : REQUIRED_DEF.allowedTargets.includes('OFFER_RESCINDED')
          ? 'OFFER_RESCINDED'
          : target;

      await installSentinelOutboxTrigger();
      try {
        await expect(
          repo.transition(
            {
              tenant_id: SENTINEL_REASON,
              placement_process_id: created.id,
              to: directTarget,
              reason_code: REQUIRED_DEF.code,
              reason_detail: 'this detail must not survive the rollback',
            },
            'caseC',
          ),
        ).rejects.toThrow(/forced outbox insert failure \(test sentinel\)/);

        // State reverted; NO reason-bearing event; NO state_changed outbox row.
        const reread = await repo.findById(SENTINEL_REASON, created.id);
        expect(reread?.state).toBe(stateBefore);
        expect(await countOutboxRows(SENTINEL_REASON, 'placement.process.state_changed')).toBe(0);
        const log = await events.listEvents(SENTINEL_REASON, created.id);
        expect(log.length).toBe(0);
        // No partial reason evidence anywhere on the event log for this aggregate.
        const anyReason = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcessEvent"
             WHERE tenant_id = '${SENTINEL_REASON}' AND reason_code IS NOT NULL`,
        );
        expect(Number(anyReason[0]!.count)).toBe(0);
        // Aggregate + created event intact (distinguishes rollback from vanish).
        expect(await countPlacementRows(SENTINEL_REASON)).toBe(1);
        expect(await countOutboxRows(SENTINEL_REASON, 'placement.process.created')).toBe(1);
      } finally {
        await dropSentinelOutboxTrigger();
      }
      expect(await productionImmutabilityTriggers()).toEqual(before);
    });

    // ---- §16 corrective (Case D) — a reason-BEARING terminal transition whose
    //      PlacementProcessEvent INSERT fails (the second injection point §16
    //      requires, distinct from the OutboxEvent-insert failure of Case A/B/C).
    //      The atomicity boundary under test is the $transaction wrapping the
    //      process-state update + event insert + outbox insert: if the event
    //      insert fails, the state update MUST roll back. RED-first was planted at
    //      that boundary (unwrapping the $transaction), not by removing the
    //      sentinel — removing the sentinel proves nothing.

    // Force the PlacementProcessEvent insert to fail for exactly the governed
    // terminal event under SENTINEL_EVENT_FAIL. Keyed on reason_code IS NOT NULL,
    // so the earlier NON-governed transition (null reason) inserts its event
    // normally and builds the prior history this proof relies on. Distinct
    // function/trigger names from the outbox sentinel — no collision.
    async function installSentinelEventTrigger(): Promise<void> {
      await setupClient.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION placement.force_event_insert_fail()
         RETURNS TRIGGER AS $$
         BEGIN
           IF NEW."tenant_id" = '${SENTINEL_EVENT_FAIL}' AND NEW."reason_code" IS NOT NULL THEN
             RAISE EXCEPTION 'forced event insert failure (test sentinel)';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql;`,
      );
      await setupClient.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS trg_test_force_event_fail ON placement."PlacementProcessEvent";`,
      );
      await setupClient.$executeRawUnsafe(
        `CREATE TRIGGER trg_test_force_event_fail
           BEFORE INSERT ON placement."PlacementProcessEvent"
           FOR EACH ROW EXECUTE FUNCTION placement.force_event_insert_fail();`,
      );
    }
    async function dropSentinelEventTrigger(): Promise<void> {
      await setupClient.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS trg_test_force_event_fail ON placement."PlacementProcessEvent";`,
      );
      await setupClient.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS placement.force_event_insert_fail();`,
      );
    }
    // The production immutability triggers on the event log (BEFORE UPDATE/DELETE
    // reject). Asserted unchanged around the test-only BEFORE INSERT sentinel.
    async function productionEventTriggers(): Promise<string[]> {
      const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'placement."PlacementProcessEvent"'::regclass AND NOT tgisinternal
          ORDER BY tgname`,
      );
      return rows.map((r) => r.tgname);
    }
    async function countEventRows(tenantId: string, placementId: string): Promise<number> {
      const r = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcessEvent"
           WHERE tenant_id = '${tenantId}' AND placement_process_id = '${placementId}'`,
      );
      return Number(r[0]!.count);
    }

    it('Case D — a reason-bearing terminal transition whose PlacementProcessEvent INSERT fails rolls back the state + emits no event/outbox/reason, and the PRIOR event history survives', async () => {
      const beforeEvtTriggers = await productionEventTriggers();
      expect(beforeEvtTriggers.length).toBeGreaterThan(0); // production immutability triggers exist

      // Build an aggregate WITH prior history: create, then one NON-governed
      // transition (null reason → sentinel does not fire) that appends event #1.
      const input = baseInput({ tenant_id: SENTINEL_EVENT_FAIL });
      const created = await repo.createPlacement(input, 'caseD-create');
      await repo.transition(
        { tenant_id: SENTINEL_EVENT_FAIL, placement_process_id: created.id, to: 'OFFER_ACCEPTED' },
        'caseD-prior',
      );
      const stateBefore = 'OFFER_ACCEPTED';
      const priorEvents = await events.listEvents(SENTINEL_EVENT_FAIL, created.id);
      expect(priorEvents).toHaveLength(1);
      expect(priorEvents[0]!.event_payload).toEqual({ from: 'OFFER_EXTENDED', to: 'OFFER_ACCEPTED' });
      const outboxStateChangedBefore = await countOutboxRows(SENTINEL_EVENT_FAIL, 'placement.process.state_changed');
      expect(outboxStateChangedBefore).toBe(1); // the prior transition's state_changed

      // A governed terminal target reachable from OFFER_ACCEPTED (OFFER_RESCINDED
      // / FELL_THROUGH), with a valid reason so the event carries reason_code and
      // the sentinel fires on ITS event insert.
      const target: PlacementState = 'FELL_THROUGH';
      const reason = reasonForTarget(target); // an active OPTIONAL code for FELL_THROUGH
      expect(reason.reason_code).toBeDefined();

      await installSentinelEventTrigger();
      try {
        await expect(
          repo.transition(
            { tenant_id: SENTINEL_EVENT_FAIL, placement_process_id: created.id, to: target, ...reason },
            'caseD',
          ),
        ).rejects.toThrow(/forced event insert failure \(test sentinel\)/);

        // The state update rolled back — EXACTLY the original state (§14 req 2),
        // not merely "not the target".
        const reread = await repo.findById(SENTINEL_EVENT_FAIL, created.id);
        expect(reread).not.toBeNull();
        expect(reread?.state).toBe(stateBefore);

        // No NEW event: the prior history survives intact, and nothing was appended.
        const afterEvents = await events.listEvents(SENTINEL_EVENT_FAIL, created.id);
        expect(afterEvents).toHaveLength(1);
        expect(afterEvents[0]!.id).toBe(priorEvents[0]!.id);
        expect(afterEvents[0]!.event_payload).toEqual({ from: 'OFFER_EXTENDED', to: 'OFFER_ACCEPTED' });
        expect(await countEventRows(SENTINEL_EVENT_FAIL, created.id)).toBe(1);

        // No NEW state_changed outbox row for the failed terminal transition.
        expect(await countOutboxRows(SENTINEL_EVENT_FAIL, 'placement.process.state_changed')).toBe(
          outboxStateChangedBefore,
        );

        // No partial reason evidence anywhere for this aggregate.
        const partial = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*)::bigint AS count FROM placement."PlacementProcessEvent"
             WHERE tenant_id = '${SENTINEL_EVENT_FAIL}'
               AND (reason_code IS NOT NULL OR reason_label_snapshot IS NOT NULL OR reason_detail IS NOT NULL)`,
        );
        expect(Number(partial[0]!.count)).toBe(0);

        // The aggregate itself still exists (rollback ≠ aggregate vanished).
        expect(await countPlacementRows(SENTINEL_EVENT_FAIL)).toBe(1);
      } finally {
        // GUARANTEED cleanup — runs on assertion failure or transition throw too.
        await dropSentinelEventTrigger();
      }

      // Production immutability triggers on the event log are unchanged by the
      // test-only sentinel (installed and dropped, leaving no residue).
      expect(await productionEventTriggers()).toEqual(beforeEvtTriggers);
    });

    // Helper: recover a placement's tenant for the OPTIONAL both-present/absent proof.
    async function tenantOf(id: string): Promise<string> {
      const row = await prisma.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM placement."PlacementProcess" WHERE id = '${id}' LIMIT 1`,
      );
      return row[0]!.tenant_id;
    }

    // ---- Track 3 / E4 — replacement lineage (repo + DB boundary) ----

    // Read the raw row including replaces_placement_process_id (the projection
    // deliberately omits it — §2 request-only, no response field).
    async function rawRow(id: string): Promise<Record<string, unknown>> {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM placement."PlacementProcess" WHERE id = '${id}' LIMIT 1`,
      );
      return rows[0]!;
    }

    // P-cyc-3 (T-cyc-3): the self-reference CHECK (INV-3) rejects a row whose
    // replaces_placement_process_id equals its own id — a depth-1 cycle is
    // impossible at the DB. Plant is a raw INSERT (the repository never writes a
    // self-pointer, so this exercises the constraint directly).
    it('E4 / P-cyc-3 (DB CHECK): INSERT with replaces = id is rejected by PlacementProcess_replaces_not_self_chk', async () => {
      const id = randomUUID();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO placement."PlacementProcess" ` +
            `(id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, replaces_placement_process_id) ` +
            `VALUES ('${id}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 'OFFER_EXTENDED', now(), '${id}')`,
        ),
      ).rejects.toThrow(/replaces_not_self_chk/);
    });

    // P-link (DB/repo write): a valid terminal predecessor is recorded on the
    // successor row; the predecessor row is byte-untouched. The successor is on a
    // DIFFERENT submittal (R2) — the one-live guard never engages.
    it('E4 / P-link (repo boundary): the successor persists replaces = predecessor.id; predecessor untouched', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const predId = await driveTo('OFFER_DECLINED', baseInput({ tenant_id: tenant, requisition_id: req }));
      const predBefore = await rawRow(predId);
      const successor = await repo.createPlacement(
        baseInput({ tenant_id: tenant, requisition_id: req, replaces_placement_process_id: predId }),
        'succ',
      );
      // Response projection carries NO replaces field (§2).
      expect(successor).not.toHaveProperty('replaces_placement_process_id');
      expect((await rawRow(successor.id))['replaces_placement_process_id']).toBe(predId);
      expect(await rawRow(predId)).toEqual(predBefore);
    });

    // P-valid-1 (T-cyc-1): a NON-terminal predecessor is refused at the repo
    // validation boundary, BEFORE any mutation. This is INV-1 — with INV-2
    // (frozen terminal rows) it makes a replacement cycle structurally impossible.
    it('E4 / P-valid-1 (repo boundary, T-cyc-1): a NON-terminal predecessor → 422 predecessor_not_terminal', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const live = await repo.createPlacement(baseInput({ tenant_id: tenant, requisition_id: req }), 'live'); // OFFER_EXTENDED
      await expect(
        repo.createPlacement(
          baseInput({ tenant_id: tenant, requisition_id: req, replaces_placement_process_id: live.id }),
          'x',
        ),
      ).rejects.toMatchObject({
        code: 'PLACEMENT_REPLACEMENT_INVALID',
        statusCode: 422,
        context: { details: { reason: 'predecessor_not_terminal' } },
      });
    });

    // P-valid-2: an absent predecessor → predecessor_not_found (tenant-scoped
    // lookup; cross-tenant/cross-requisition fold here — least-visibility).
    it('E4 / P-valid-2 (repo boundary): an absent predecessor → 422 predecessor_not_found', async () => {
      await expect(
        repo.createPlacement(baseInput({ replaces_placement_process_id: randomUUID() }), 'x'),
      ).rejects.toMatchObject({
        code: 'PLACEMENT_REPLACEMENT_INVALID',
        statusCode: 422,
        context: { details: { reason: 'predecessor_not_found' } },
      });
    });

    // T-cyc-2 (characterization, INV-2 — the frozen-predecessor invariant §4's
    // acyclicity rests on): every UPDATE to a terminal-state row is rejected by
    // the generated lifecycle trigger. Existing behaviour; reported as
    // characterization, NOT reconstructed as RED-first.
    it('E4 / T-cyc-2 (characterization): any UPDATE to a terminal placement is rejected by the lifecycle trigger', async () => {
      const tenant = randomUUID();
      const termId = await driveTo('OFFER_DECLINED', baseInput({ tenant_id: tenant }));
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE placement."PlacementProcess" SET requisition_id = '${randomUUID()}' WHERE id = '${termId}'`,
        ),
      ).rejects.toThrow(/only the 14 legal state transitions/);
    });
  },
);

// Dollar-quote-aware DDL splitter (submittal/CTR precedent) — splits on `;`
// outside `$$` regions. Does NOT strip line comments, which is why the
// generator forbids `;`/`$$` inside comment lines.
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
