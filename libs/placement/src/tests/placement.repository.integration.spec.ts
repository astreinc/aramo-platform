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
// E1-c — the additive offer-snapshot + OutboxEvent migration, applied AFTER init.
const OFFER_OUTBOX_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260805120000_placement_offer_and_outbox/migration.sql',
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
      // Apply the init migration then the additive E1-c migration, in order.
      for (const path of [INIT_MIGRATION_PATH, OFFER_OUTBOX_MIGRATION_PATH]) {
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
      const input = baseInput({ offered_at, client_offer_reference: 'REF-OUT', proposed_start_date: null, offer_expires_at: null });
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
