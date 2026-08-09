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
  RequisitionRepository,
  RequisitionPrismaService,
} from '@aramo/requisition';
import { deriveCapacity } from '@aramo/placement';

// Track 1 T1-b — optimistic concurrency on requisition.Requisition, exercised
// against real Postgres 17. Lives in apps/api because libs/requisition is NOT
// an integration ROOT; apps/api is, and re-exports the repository.
//
// Proof matrix (directive TESTS block):
//   1. Stale version → 409 REQUISITION_VERSION_CONFLICT, and the row is
//      UNCHANGED (assert BOTH the mutated field and the version).
//   2. Current version → succeeds + version increments.
//   3. NO version (additive posture, R4) → succeeds + version STILL increments.
//   4. A non-status field change increments the version too (R1 — a stale write
//      is stale regardless of which field it targets).
//   5. stampGoldenProfileId increments the version (R3 — no exemption).
//
// This spec is the one that must FAIL FIRST against the pre-change repository:
// pre-change update() ignores `version`, never increments, and never raises the
// conflict — so tests 1–5 all fail (see the Gate-6 fail-first evidence).
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const TENANT_A = '01900000-0000-7000-8000-0000000000e1';
const COMPANY_A = '01900000-0000-7000-8000-0000000000f1';

// migrationsFor reads the folder dynamically (sorted) so the T1-b
// add_version_to_requisition migration is applied without a hardcoded list.
function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition')];

// The full-editor scope set — passes the status-only / comp / financial
// edit-gates so those gates are not the thing under test here.
const EDIT_SCOPES = ['requisition:edit'] as const;

const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Requisition optimistic concurrency (T1-b) — real Postgres 17',
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
      // SET_PRIORITY policy is only consulted when is_hot is set TRUE (R3);
      // none of these tests do, so gateSetPriority returns null before ever
      // touching the policy service — a throwing stub proves it is never called.
      const setPriorityStub = {
        decide: async () => {
          throw new Error('SetPriorityPolicyService.decide must not be called');
        },
      } as never;
      // T1-e — the transition gate is likewise never reached: every update here
      // changes title/city, not status, so gateTransition short-circuits before
      // touching the policy service. A throwing stub proves it is not called.
      const transitionStub = {
        decide: async () => {
          throw new Error('RequisitionTransitionPolicyService.decide must not be called');
        },
      } as never;
      // Track 4 / T4-B2 — 4th ctor arg (capacity projection). These specs seed
      // NO ContractAssignment rows, so consuming_count is 0 and the derived
      // openings_available equals the requisition's total openings. A local stub
      // avoids needing the placement schema in this container.
      const capacityStub = {
        projectCapacity: async (_t: string, _r: string, openings: number) =>
          deriveCapacity({ openings, consuming_count: 0 }),
        countActiveByRequisitionIds: async () => new Map<string, number>(),
      } as never;
      repo = new RequisitionRepository(prisma, setPriorityStub, transitionStub, capacityStub);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    // Seed one requisition row with only the required columns (mirrors the
    // pact-provider seed shape) and return its id. version defaults to 0.
    async function seedRequisition(title: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2::uuid))`,
        [id, TENANT_A, title, COMPANY_A],
      );
      return id;
    }

    async function readRow(id: string): Promise<{ title: string; version: number; city: string | null }> {
      const { rows } = await db.query(
        `SELECT title, version, city FROM requisition."Requisition" WHERE id = $1::uuid`,
        [id],
      );
      return rows[0] as { title: string; version: number; city: string | null };
    }

    it('stale version → 409 REQUISITION_VERSION_CONFLICT and the row is UNCHANGED', async () => {
      const id = await seedRequisition('Original');

      // Move the row forward once with the correct version (0 → 1).
      await repo.update({
        tenant_id: TENANT_A,
        id,
        input: { title: 'First', version: 0 },
        scopes: EDIT_SCOPES,
        actor_id: 'actor-1',
        requestId: REQUEST_ID,
      });
      const afterFirst = await readRow(id);
      expect(afterFirst.title).toBe('First');
      expect(afterFirst.version).toBe(1);

      // Now attempt a write with the STALE version 0 — someone else already
      // moved it to 1. Must be refused with the registered code.
      await expect(
        repo.update({
          tenant_id: TENANT_A,
          id,
          input: { title: 'Stale write', version: 0 },
          scopes: EDIT_SCOPES,
          actor_id: 'actor-1',
          requestId: REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'REQUISITION_VERSION_CONFLICT', statusCode: 409 });

      // The row must be UNCHANGED: the stale title was NOT written and the
      // version did NOT advance.
      const afterStale = await readRow(id);
      expect(afterStale.title).toBe('First');
      expect(afterStale.version).toBe(1);
    });

    it('current version → succeeds and the version increments', async () => {
      const id = await seedRequisition('Original');

      await repo.update({
        tenant_id: TENANT_A,
        id,
        input: { title: 'Retitled', version: 0 },
        scopes: EDIT_SCOPES,
        actor_id: 'actor-1',
        requestId: REQUEST_ID,
      });

      const row = await readRow(id);
      expect(row.title).toBe('Retitled');
      expect(row.version).toBe(1);
    });

    it('NO version supplied → succeeds (additive posture) and the version still increments', async () => {
      const id = await seedRequisition('Original');

      await repo.update({
        tenant_id: TENANT_A,
        id,
        input: { title: 'Unguarded update' }, // no version field at all
        scopes: EDIT_SCOPES,
        actor_id: 'actor-1',
        requestId: REQUEST_ID,
      });

      const row = await readRow(id);
      expect(row.title).toBe('Unguarded update');
      expect(row.version).toBe(1);
    });

    it('a non-status field change increments the version too', async () => {
      const id = await seedRequisition('Original');

      // No status field in the input — only city (a non-status field).
      await repo.update({
        tenant_id: TENANT_A,
        id,
        input: { city: 'Austin', version: 0 },
        scopes: EDIT_SCOPES,
        actor_id: 'actor-1',
        requestId: REQUEST_ID,
      });

      const row = await readRow(id);
      expect(row.city).toBe('Austin');
      expect(row.version).toBe(1);
    });

    it('stampGoldenProfileId increments the version (R3 — no exemption)', async () => {
      const id = await seedRequisition('Original');

      await repo.stampGoldenProfileId({
        tenant_id: TENANT_A,
        id,
        golden_profile_id: uuidv7(),
        requestId: REQUEST_ID,
      });

      const row = await readRow(id);
      expect(row.version).toBe(1);
    });
  },
);
