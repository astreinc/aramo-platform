import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RequisitionLifecycleEventStore,
  RequisitionPrismaService,
} from '@aramo/requisition';

// ADR-0024 §D17c — the append-only lifecycle history write API against real
// Postgres. Lives in apps/api because libs/requisition is not an integration
// ROOT; apps/api is, and re-exports the store. Skipped unless
// ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const TENANT_A = '01900000-0000-7000-8000-0000000000c1';
const TENANT_B = '01900000-0000-7000-8000-0000000000c2';
const REQ_1 = '01900000-0000-7000-8000-0000000000d1';
const REQ_2 = '01900000-0000-7000-8000-0000000000d2';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
// requisition owns the model; policy-store supplies a real PolicyDecisionRecord
// for the cross-schema link test.
const MIGRATIONS = [
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
];

// Insert a real policy_store.PolicyDecisionRecord via raw SQL (no @aramo/policy-
// store import → no cross-lib edge) and return its id, so the lifecycle event's
// policy_decision_id can link to a row that genuinely exists.
async function seedDecisionRecord(
  db: Client,
  tenantId: string,
  correlationId: string,
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO policy_store."PolicyDecisionRecord"
       (id, tenant_id, decision, policy_version, rule_id, reason_code, resource, action, inputs, actor_id, origin, correlation_id)
     VALUES ($1,$2,'ALLOW','1.0.0','close-active','LIFECYCLE_CLOSE_ALLOWED','REQUISITION','CLOSE','{}'::jsonb,$3,'ui',$4)`,
    [id, tenantId, 'actor-1', correlationId],
  );
  return id;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionLifecycleEventStore (§D17c) — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: RequisitionPrismaService;
    let store: RequisitionLifecycleEventStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      store = new RequisitionLifecycleEventStore(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    it('records both statuses (previous + next) and reads them back', async () => {
      const rec = await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_1,
        previous_status: 'open',
        next_status: 'on_hold',
        actor_id: 'actor-1',
        origin: 'ui',
        reason_code: 'RECRUITER_HOLD',
        correlation_id: uuidv7(),
      });
      expect(rec.previous_status).toBe('open');
      expect(rec.next_status).toBe('on_hold');

      const read = await store.getById(TENANT_A, rec.id);
      expect(read).not.toBeNull();
      expect(read?.previous_status).toBe('open');
      expect(read?.next_status).toBe('on_hold');
      expect(read?.origin).toBe('ui');
    });

    it('correlation_id groups the records of one command (oldest first)', async () => {
      const correlationId = uuidv7();
      await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_1,
        previous_status: 'open',
        next_status: 'submittals_closed',
        actor_id: 'actor-1',
        origin: 'agent',
        reason_code: 'A',
        correlation_id: correlationId,
        occurred_at: new Date('2026-07-31T10:00:00Z'),
      });
      await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_2,
        previous_status: 'open',
        next_status: 'closed',
        actor_id: 'actor-1',
        origin: 'agent',
        reason_code: 'B',
        correlation_id: correlationId,
        occurred_at: new Date('2026-07-31T10:00:01Z'),
      });

      const group = await store.listByCorrelation(TENANT_A, correlationId);
      expect(group).toHaveLength(2);
      expect(group.map((e) => e.next_status)).toEqual(['submittals_closed', 'closed']); // ordered
    });

    it('policy_decision_id round-trips and links to a real PolicyDecisionRecord', async () => {
      const correlationId = uuidv7();
      const decisionId = await seedDecisionRecord(db, TENANT_A, correlationId);

      const rec = await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_1,
        previous_status: 'open',
        next_status: 'closed',
        actor_id: 'actor-1',
        origin: 'ui',
        reason_code: 'CLOSED_BY_OWNER',
        policy_decision_id: decisionId,
        correlation_id: correlationId,
      });

      const read = await store.getById(TENANT_A, rec.id);
      expect(read?.policy_decision_id).toBe(decisionId);
      // The referenced decision genuinely exists in policy_store (UUID-only
      // cross-schema link, no FK).
      const { rows } = await db.query(
        `SELECT id FROM policy_store."PolicyDecisionRecord" WHERE id=$1`,
        [read?.policy_decision_id],
      );
      expect(rows).toHaveLength(1);
    });

    it('policy_decision_id is null for a transition predating policy governance', async () => {
      const rec = await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_2,
        previous_status: 'closed',
        next_status: 'open',
        actor_id: 'actor-1',
        origin: 'integration',
        reason_code: 'REOPEN_UNGOVERNED',
        correlation_id: uuidv7(),
        // no policy_decision_id
      });
      const read = await store.getById(TENANT_A, rec.id);
      expect(read?.policy_decision_id).toBeNull();
    });

    it('tenant isolation — a record for A is invisible to B', async () => {
      const rec = await store.record({
        tenant_id: TENANT_A,
        requisition_id: REQ_1,
        previous_status: 'open',
        next_status: 'canceled',
        actor_id: 'actor-1',
        origin: 'ui',
        reason_code: 'X',
        correlation_id: uuidv7(),
      });
      expect(await store.getById(TENANT_B, rec.id)).toBeNull();
      expect(await store.listByRequisition(TENANT_B, REQ_1)).toEqual([]);
    });
  },
);
