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

// PR-17 — hybrid onsite frequency, server-side floor + the work_arrangement
// coupling, against real Postgres. onsite_days_per_week is meaningful ONLY when
// work_arrangement = 'hybrid' and only in 1-4; the repository enforces it (the
// form does not). Lives in apps/api (an integration ROOT that re-exports
// @aramo/requisition). Skipped unless ARAMO_RUN_INTEGRATION=1.
//
// SetPriorityPolicyService is stubbed ({} as never) — the gate short-circuits
// when is_hot !== true and no test sets is_hot.

const ROOT = resolve(__dirname, '../../../..');
const TENANT = '01900000-0000-7000-8000-0000000000a7';
const ACTOR = '01900000-0000-7000-8000-000000000a71';
const COMPANY = '01900000-0000-7000-8000-000000000a72';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition')];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionRepository — onsite_days_per_week (PR-17) — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: RequisitionPrismaService;
    let repo: RequisitionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      repo = new RequisitionRepository(prisma, {} as never);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    function create(input: Record<string, unknown>) {
      return repo.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { title: 'Engineer', company_id: COMPANY, ...input } as never,
        scopes: [],
        requestId: uuidv7(),
      });
    }
    function update(id: string, input: Record<string, unknown>) {
      return repo.update({
        tenant_id: TENANT,
        id,
        input: input as never,
        scopes: ['requisition:edit'],
        actor_id: ACTOR,
        requestId: uuidv7(),
      });
    }
    async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
      try {
        await p;
        return undefined;
      } catch (err) {
        return (err as { code?: string }).code;
      }
    }

    it('create: non-hybrid arrangement + an onsite value → rejected (VALIDATION_ERROR)', async () => {
      expect(
        await codeOf(create({ work_arrangement: 'remote', onsite_days_per_week: 3 })),
      ).toBe('VALIDATION_ERROR');
      // onsite arrangement is a work_arrangement, not a frequency — also rejected.
      expect(
        await codeOf(create({ work_arrangement: 'onsite', onsite_days_per_week: 2 })),
      ).toBe('VALIDATION_ERROR');
    });

    it('create: onsite 0 and 5 rejected (0 = remote, 5 = onsite are arrangements)', async () => {
      expect(
        await codeOf(create({ work_arrangement: 'hybrid', onsite_days_per_week: 0 })),
      ).toBe('VALIDATION_ERROR');
      expect(
        await codeOf(create({ work_arrangement: 'hybrid', onsite_days_per_week: 5 })),
      ).toBe('VALIDATION_ERROR');
    });

    it('create: hybrid + 1-4 persists; hybrid + null is allowed (unknown frequency)', async () => {
      const a = await create({ work_arrangement: 'hybrid', onsite_days_per_week: 3 });
      expect(a.onsite_days_per_week).toBe(3);
      const b = await create({ work_arrangement: 'hybrid' }); // omitted → null
      expect(b.onsite_days_per_week).toBeNull();
    });

    it('update: changing work_arrangement AWAY from hybrid NULLS onsite (coupling), even when the PATCH omits it', async () => {
      const r = await create({ work_arrangement: 'hybrid', onsite_days_per_week: 4 });
      expect(r.onsite_days_per_week).toBe(4);
      const after = await update(r.id, { work_arrangement: 'remote' }); // onsite not in PATCH
      expect(after.work_arrangement).toBe('remote');
      expect(after.onsite_days_per_week).toBeNull();
    });

    it('update: setting an onsite value while the effective arrangement is non-hybrid → rejected', async () => {
      const r = await create({ work_arrangement: 'remote' }); // onsite null
      // PATCH onsite only; work_arrangement stays remote (effective) → rejected.
      expect(await codeOf(update(r.id, { onsite_days_per_week: 3 }))).toBe(
        'VALIDATION_ERROR',
      );
      // PATCH both to non-hybrid + a value → rejected too.
      const h = await create({ work_arrangement: 'hybrid', onsite_days_per_week: 2 });
      expect(
        await codeOf(
          update(h.id, { work_arrangement: 'remote', onsite_days_per_week: 2 }),
        ),
      ).toBe('VALIDATION_ERROR');
    });

    it('update: hybrid → new valid onsite value persists; explicit null clears it', async () => {
      const r = await create({ work_arrangement: 'hybrid', onsite_days_per_week: 3 });
      const two = await update(r.id, { onsite_days_per_week: 2 });
      expect(two.onsite_days_per_week).toBe(2);
      const cleared = await update(r.id, { onsite_days_per_week: null });
      expect(cleared.onsite_days_per_week).toBeNull();
      expect(cleared.work_arrangement).toBe('hybrid'); // still hybrid, just unknown
    });
  },
);
