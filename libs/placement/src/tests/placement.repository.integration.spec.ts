import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PlacementProcessEventRepository } from '../lib/placement-process-event.repository.js';
import { LEGAL_TRANSITIONS, type PlacementState } from '../lib/lifecycle/placement-lifecycle.js';
import type { CreatePlacementInput } from '../lib/placement-process.types.js';

// Track 3 / E1-a — integration spec (real Postgres 17). One migration applies
// the whole placement schema (new schema, no cross-lib deps). Proves the
// directive tripwires end-to-end: the 14-edge BEFORE UPDATE matrix, the
// BEFORE INSERT one-live-attempt guard, event-log immutability, and tenant
// isolation. The migration SQL is a generated artifact; this exercises it.

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260803180000_init_placement_model/migration.sql',
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

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      const sql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
      for (const stmt of splitDdl(sql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
      events = new PlacementProcessEventRepository(prisma);
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
        const v = await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'drive');
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
        // exercise the edge
        const moved = await repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: edge.to },
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
          await repo.transition({ tenant_id: shared.tenant_id, placement_process_id: created.id, to }, 'walk');
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
        await repo.transition({ tenant_id: shared.tenant_id, placement_process_id: created.id, to }, 'walk');
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
