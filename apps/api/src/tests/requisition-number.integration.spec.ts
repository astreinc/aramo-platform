import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequisitionPrismaService, RequisitionRepository } from '@aramo/requisition';

// PR-15 — internal requisition_number: per-tenant monotonic allocator (starts at
// 1000), assigned at create in the same transaction, immutable, never reused;
// plus the deterministic per-tenant backfill. Real Postgres. Lives in apps/api
// (an integration ROOT that re-exports @aramo/requisition). Skipped unless
// ARAMO_RUN_INTEGRATION=1. SetPriorityPolicyService is stubbed ({} as never) —
// the gate short-circuits when is_hot !== true and no test sets is_hot.

const ROOT = resolve(__dirname, '../../../..');

function requisitionMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/requisition/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const NUMBER_MIGRATION_DIR = '20260802180000_add_requisition_number';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionRepository — requisition_number allocator (PR-15) — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: RequisitionPrismaService;
    let repo: RequisitionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const p of requisitionMigrations()) await db.query(readFileSync(p, 'utf8'));
      await db.end();
      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      // T1-e — 3rd ctor arg (transition policy); never invoked (no status change).
      repo = new RequisitionRepository(prisma, {} as never, {} as never);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await container?.stop();
    }, 60_000);

    function create(tenant: string) {
      const actor = uuidv7();
      return repo.create({
        tenant_id: tenant,
        entered_by_id: actor,
        input: { title: 'Engineer', company_id: uuidv7() } as never,
        scopes: [],
        requestId: uuidv7(),
      });
    }

    it('the first requisition in a tenant is REQ-1000; subsequent numbers increment monotonically', async () => {
      const tenant = uuidv7();
      const a = await create(tenant);
      const b = await create(tenant);
      const c = await create(tenant);
      expect(a.requisition_number).toBe(1000);
      expect(b.requisition_number).toBe(1001);
      expect(c.requisition_number).toBe(1002);
    });

    it('numbering is PER-TENANT — a second tenant also starts at 1000', async () => {
      const t1 = uuidv7();
      const t2 = uuidv7();
      await create(t1);
      await create(t1);
      const first2 = await create(t2);
      expect(first2.requisition_number).toBe(1000);
    });

    it('LOAD-BEARING — concurrent creates in one tenant get DISTINCT numbers', async () => {
      const tenant = uuidv7();
      const N = 25;
      const results = await Promise.all(
        Array.from({ length: N }, () => create(tenant)),
      );
      const numbers = results.map((r) => r.requisition_number);
      const distinct = new Set(numbers);
      expect(distinct.size).toBe(N); // no collisions under concurrency
      // contiguous 1000..1000+N-1 (no gaps when nothing rolled back)
      expect(Math.min(...numbers)).toBe(1000);
      expect(Math.max(...numbers)).toBe(1000 + N - 1);
    });

    it('NEVER REUSED — deleting the highest-numbered requisition does not free its number', async () => {
      const tenant = uuidv7();
      await create(tenant); // 1000
      await create(tenant); // 1001
      const top = await create(tenant); // 1002
      expect(top.requisition_number).toBe(1002);
      await repo.delete({ tenant_id: tenant, id: top.id, requestId: uuidv7() });
      const next = await create(tenant);
      expect(next.requisition_number).toBe(1003); // NOT 1002 — the gap stays
    });

    it('IMMUTABLE — an update never changes requisition_number', async () => {
      const tenant = uuidv7();
      const r = await create(tenant);
      const before = r.requisition_number;
      const updated = await repo.update({
        tenant_id: tenant,
        id: r.id,
        input: { title: 'Renamed' } as never,
        scopes: ['requisition:edit'],
        actor_id: uuidv7(),
        requestId: uuidv7(),
      });
      expect(updated.requisition_number).toBe(before);
      // The field is not on the Update DTO, so a body carrying it cannot set it.
      const forced = await repo.update({
        tenant_id: tenant,
        id: r.id,
        input: { requisition_number: 9999 } as never,
        scopes: ['requisition:edit'],
        actor_id: uuidv7(),
        requestId: uuidv7(),
      });
      expect(forced.requisition_number).toBe(before);
    });
  },
);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-15 backfill — deterministic, per-tenant, from 1000',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;

    const T1 = uuidv7();
    const T2 = uuidv7();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      // Apply every requisition migration EXCEPT the PR-15 number migration, so
      // the table exists WITHOUT requisition_number and we can seed rows first.
      for (const p of requisitionMigrations()) {
        if (p.includes(NUMBER_MIGRATION_DIR)) continue;
        await db.query(readFileSync(p, 'utf8'));
      }
      // Seed out of created_at order to prove the backfill orders by created_at.
      async function seed(tenant: string, title: string, createdAt: string) {
        await db.query(
          `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz)`,
          [uuidv7(), tenant, title, uuidv7(), createdAt],
        );
      }
      await seed(T1, 'T1-second', '2026-02-01T00:00:00Z');
      await seed(T1, 'T1-first', '2026-01-01T00:00:00Z');
      await seed(T1, 'T1-third', '2026-03-01T00:00:00Z');
      await seed(T2, 'T2-only', '2026-01-15T00:00:00Z');
      // Now apply the PR-15 migration (adds column, backfills, NOT NULL, seeds counter).
      const numberMig = requisitionMigrations().find((p) =>
        p.includes(NUMBER_MIGRATION_DIR),
      )!;
      await db.query(readFileSync(numberMig, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    it('backfills each tenant in created_at order starting at 1000', async () => {
      const { rows } = await db.query(
        `SELECT title, requisition_number FROM requisition."Requisition"
          WHERE tenant_id = $1::uuid ORDER BY requisition_number ASC`,
        [T1],
      );
      expect(rows).toEqual([
        { title: 'T1-first', requisition_number: 1000 },
        { title: 'T1-second', requisition_number: 1001 },
        { title: 'T1-third', requisition_number: 1002 },
      ]);
    });

    it('is per-tenant — the second tenant also starts at 1000', async () => {
      const { rows } = await db.query(
        `SELECT requisition_number FROM requisition."Requisition" WHERE tenant_id = $1::uuid`,
        [T2],
      );
      expect(rows).toEqual([{ requisition_number: 1000 }]);
    });

    it('seeds the allocator to the last number handed out per tenant (next create = max+1, no duplicate)', async () => {
      const { rows } = await db.query(
        `SELECT tenant_id, next_value FROM requisition."RequisitionNumberSequence" ORDER BY next_value DESC`,
      );
      const byTenant = new Map(rows.map((r) => [r.tenant_id, r.next_value]));
      expect(byTenant.get(T1)).toBe(1002); // last handed out for T1
      expect(byTenant.get(T2)).toBe(1000); // last handed out for T2
    });
  },
);
