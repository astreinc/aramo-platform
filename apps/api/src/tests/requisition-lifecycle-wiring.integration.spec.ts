import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RequisitionLifecycleEventStore,
  RequisitionPrismaService,
  RequisitionRepository,
} from '@aramo/requisition';

// Track 1 T1-c — the lifecycle-event WIRING against real Postgres. PR-0c shipped
// the append-only store with no producer; this asserts every path that changes
// requisition.status now emits exactly one lifecycle event, atomically, and that
// the paths that do NOT change status (or delete) emit nothing. Lives in apps/api
// (an integration ROOT that re-exports @aramo/requisition). Skipped unless
// ARAMO_RUN_INTEGRATION=1.
//
// The repository is constructed with a stub SetPriorityPolicyService ({} as
// never): the SET_PRIORITY gate short-circuits to null whenever is_hot !== true,
// and no test sets is_hot, so the stub is never invoked (mirrors
// job-distribution-sync.integration.spec.ts). Only the requisition schema is
// needed — the lifecycle write is same-schema, same-client.

const ROOT = resolve(__dirname, '../../../..');
const TENANT_A = '01900000-0000-7000-8000-0000000000e1';
// entered_by_id / recruiter_id / owner_id are @db.Uuid on Requisition, so the
// actor ids must be UUIDs (the lifecycle event's actor_id column is TEXT and
// stores them verbatim).
const ACTOR_1 = '01900000-0000-7000-8000-000000000a01';
const ACTOR_2 = '01900000-0000-7000-8000-000000000a02';
const COMPANY = '01900000-0000-7000-8000-0000000000f1';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition')];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionRepository — lifecycle-event wiring (T1-c) — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: RequisitionPrismaService;
    let repo: RequisitionRepository;
    let store: RequisitionLifecycleEventStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      // Stub SetPriorityPolicyService — never called (no test sets is_hot).
      repo = new RequisitionRepository(prisma, {} as never);
      store = new RequisitionLifecycleEventStore(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    async function createReq(
      status?: 'active' | 'on_hold' | 'full' | 'closed' | 'canceled' | 'lead',
      requestId: string = uuidv7(),
    ) {
      return repo.create({
        tenant_id: TENANT_A,
        entered_by_id: ACTOR_1,
        input: {
          title: 'Senior Engineer',
          company_id: COMPANY,
          ...(status === undefined ? {} : { status }),
        } as never,
        scopes: [],
        requestId,
      });
    }

    it('create → ONE event, previous_status NULL, next_status the created status (R1)', async () => {
      const requestId = uuidv7();
      const view = await createReq(undefined, requestId);

      const events = await store.listByRequisition(TENANT_A, view.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.previous_status).toBeNull(); // R1
      expect(events[0]?.next_status).toBe('active'); // default created status
      expect(events[0]?.origin).toBe('ui');
      expect(events[0]?.actor_id).toBe(ACTOR_1);
      expect(events[0]?.policy_decision_id).toBeNull(); // T1-e supplies one
      expect(events[0]?.correlation_id).toBe(requestId);
    });

    it('create with an explicit status → next_status is that status, previous_status NULL', async () => {
      const view = await createReq('lead');
      const events = await store.listByRequisition(TENANT_A, view.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.previous_status).toBeNull();
      expect(events[0]?.next_status).toBe('lead');
    });

    it('update changing status → ONE event with the correct previous and next', async () => {
      const created = await createReq(); // event 1: null → active
      const requestId = uuidv7();
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'on_hold' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId,
      });

      const events = await store.listByRequisition(TENANT_A, created.id);
      expect(events).toHaveLength(2);
      const upd = events[1];
      expect(upd?.previous_status).toBe('active');
      expect(upd?.next_status).toBe('on_hold');
      expect(upd?.actor_id).toBe(ACTOR_2);
      expect(upd?.correlation_id).toBe(requestId);
    });

    it('update NOT touching status → ZERO events (R2)', async () => {
      const created = await createReq();
      const before = (await store.listByRequisition(TENANT_A, created.id)).length;
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { title: 'Renamed role' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: uuidv7(),
      });
      const after = (await store.listByRequisition(TENANT_A, created.id)).length;
      expect(after).toBe(before); // no new event
    });

    it('update setting status to its CURRENT value → ZERO events (R2)', async () => {
      const created = await createReq(); // status active
      const before = (await store.listByRequisition(TENANT_A, created.id)).length;
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'active' } as never, // same value
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: uuidv7(),
      });
      const after = (await store.listByRequisition(TENANT_A, created.id)).length;
      expect(after).toBe(before); // no new event
    });

    it('createForImport → ONE event, origin=integration (R4), previous_status NULL', async () => {
      const view = await repo.createForImport({
        tenant_id: TENANT_A,
        entered_by_id: ACTOR_1,
        import_batch_id: uuidv7(),
        input: { title: 'Imported role', company_id: COMPANY, status: 'active' } as never,
        scopes: [],
        requestId: uuidv7(),
      });
      const events = await store.listByRequisition(TENANT_A, view.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.origin).toBe('integration'); // R4
      expect(events[0]?.previous_status).toBeNull(); // still a create
      expect(events[0]?.next_status).toBe('active');
    });

    it('delete → ZERO new events, and PRIOR events for that requisition SURVIVE (R5)', async () => {
      const created = await createReq(); // event 1
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'closed' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: uuidv7(),
      }); // event 2
      const before = await store.listByRequisition(TENANT_A, created.id);
      expect(before).toHaveLength(2);

      await repo.delete({ tenant_id: TENANT_A, id: created.id, requestId: uuidv7() });

      // The requisition is gone…
      expect(
        await repo.findByIdAdmin({ tenant_id: TENANT_A, id: created.id }),
      ).toBeNull();
      // …but its history survives (bare-UUID, no FK — R5).
      const after = await store.listByRequisition(TENANT_A, created.id);
      expect(after).toHaveLength(2);
      expect(after.map((e) => e.next_status)).toEqual(['active', 'closed']);
    });

    it('deleteByImportBatch → prior events SURVIVE the bulk reversion (R5)', async () => {
      const batch = uuidv7();
      const view = await repo.createForImport({
        tenant_id: TENANT_A,
        entered_by_id: ACTOR_1,
        import_batch_id: batch,
        input: { title: 'Batch role', company_id: COMPANY, status: 'active' } as never,
        scopes: [],
        requestId: uuidv7(),
      });
      expect(await store.listByRequisition(TENANT_A, view.id)).toHaveLength(1);

      await repo.deleteByImportBatch({ tenant_id: TENANT_A, import_batch_id: batch });

      expect(await repo.findByIdAdmin({ tenant_id: TENANT_A, id: view.id })).toBeNull();
      expect(await store.listByRequisition(TENANT_A, view.id)).toHaveLength(1); // survives
    });

    it('correlation_id groups the events of one command', async () => {
      const r1 = uuidv7();
      const created = await createReq(undefined, r1);
      const r2 = uuidv7();
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'on_hold' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: r2,
      });

      const g1 = await store.listByCorrelation(TENANT_A, r1);
      expect(g1).toHaveLength(1);
      expect(g1[0]?.next_status).toBe('active'); // the create command

      const g2 = await store.listByCorrelation(TENANT_A, r2);
      expect(g2).toHaveLength(1);
      expect(g2[0]?.next_status).toBe('on_hold'); // the update command
    });

    it('previous_status is NULL ONLY on create — no update path yields a null previous_status', async () => {
      const created = await createReq(); // event 1: null → active
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'on_hold' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: uuidv7(),
      }); // event 2: active → on_hold
      await repo.update({
        tenant_id: TENANT_A,
        id: created.id,
        input: { status: 'closed' } as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR_2,
        requestId: uuidv7(),
      }); // event 3: on_hold → closed

      const events = await store.listByRequisition(TENANT_A, created.id);
      expect(events).toHaveLength(3);
      expect(events[0]?.previous_status).toBeNull(); // the create
      expect(events.slice(1).every((e) => e.previous_status !== null)).toBe(true);
      expect(events.filter((e) => e.previous_status === null)).toHaveLength(1);
    });

    it('ATOMICITY (R3) — when the event write fails on a status change, the status is UNCHANGED', async () => {
      const created = await createReq(); // status active, 1 event committed
      const spy = vi
        .spyOn(
          repo as unknown as { recordLifecycleEventInTx: () => Promise<void> },
          'recordLifecycleEventInTx',
        )
        .mockRejectedValue(new Error('injected lifecycle write failure'));

      // The injection throws AFTER the status UPDATE runs inside the transaction
      // (recordLifecycleEventInTx is awaited after tx.requisition.update), so a
      // fail-closed transaction must roll the status change back.
      await expect(
        repo.update({
          tenant_id: TENANT_A,
          id: created.id,
          input: { status: 'closed' } as never,
          scopes: ['requisition:edit'],
          actor_id: ACTOR_2,
          requestId: uuidv7(),
        }),
      ).rejects.toThrow(/injected lifecycle write failure/);

      spy.mockRestore();

      // Status rolled back to 'active' — the mutation never committed without
      // its lifecycle event.
      const after = await repo.findByIdAdmin({ tenant_id: TENANT_A, id: created.id });
      expect(after?.status).toBe('active');
      // …and no update event was written (only the original create survives).
      const events = await store.listByRequisition(TENANT_A, created.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.next_status).toBe('active');
    });

    it('ATOMICITY (R3) — when the event write fails on a create, NO requisition row is committed', async () => {
      const spy = vi
        .spyOn(
          repo as unknown as { recordLifecycleEventInTx: () => Promise<void> },
          'recordLifecycleEventInTx',
        )
        .mockRejectedValue(new Error('injected lifecycle write failure'));

      const requestId = uuidv7();
      await expect(createReq(undefined, requestId)).rejects.toThrow(
        /injected lifecycle write failure/,
      );
      spy.mockRestore();

      // No requisition row exists for that correlation — the create rolled back.
      const { rows } = await db.query(
        `SELECT id FROM requisition."Requisition" WHERE tenant_id = $1 AND title = 'Senior Engineer' AND id NOT IN (SELECT requisition_id FROM requisition."RequisitionLifecycleEvent")`,
        [TENANT_A],
      );
      // Any surviving 'Senior Engineer' row must still have its create event —
      // the rolled-back create left neither row nor event.
      expect(rows).toHaveLength(0);
    });

    // T1-b × T1-c composition — the interaction neither PR could cover alone.
    // The version compare-and-swap (T1-b) runs FIRST inside the update
    // transaction; a stale-version write matches zero rows and throws
    // REQUISITION_VERSION_CONFLICT before recordLifecycleEventInTx is reached.
    // A rejected write that still recorded history would produce a lifecycle
    // event for a status change that never happened — this proves it does not.
    it('a stale-version update fails the CAS and writes NO lifecycle event', async () => {
      const created = await createReq(); // version 0; 1 create event
      // Supply a STALE expected version with a real status change.
      let caught: unknown;
      try {
        await repo.update({
          tenant_id: TENANT_A,
          id: created.id,
          input: { status: 'closed', version: 99 } as never, // 99 !== current (0)
          scopes: ['requisition:edit'],
          actor_id: ACTOR_2,
          requestId: uuidv7(),
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe(
        'REQUISITION_VERSION_CONFLICT',
      );

      // The CAS matched zero rows → status unchanged …
      const after = await repo.findByIdAdmin({ tenant_id: TENANT_A, id: created.id });
      expect(after?.status).toBe('active');
      // … and NO lifecycle event was written (only the original create survives).
      const events = await store.listByRequisition(TENANT_A, created.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.next_status).toBe('active');
    });
  },
);
