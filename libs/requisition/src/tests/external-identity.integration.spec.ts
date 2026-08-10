import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveCapacity } from '@aramo/placement';

import { RequisitionRepository } from '../lib/requisition.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// T8-P1 — canonical external-requisition identity (VMS Integration Directive
// v1.0 §5). Exercised against real Postgres 17.
//
// Proof matrix (directive §12 boundaries):
//   B — a duplicate (tenant_id, source_system, external_req_id) is REJECTED with
//       the typed 409 REQUISITION_EXTERNAL_IDENTITY_CONFLICT (never a raw P2002),
//       and case-variant source_system collapses into the SAME identity (the
//       normalization that makes the index sound).
//   C — the SAME external id under a DIFFERENT tenant is allowed (tenant-scoped).
//   D — the SAME external id under a DIFFERENT source_system is distinct.
//   E — an ordinary requisition with NO external identity (and one tagged with a
//       source_system but no external_req_id) remains valid, repeatedly — the
//       index is PARTIAL, not total.
//   F — the migration produces the exact partial-unique invariant: the index
//       exists with the (tenant, source, external) key and the NOT-NULL WHERE
//       predicate, and a raw duplicate insert raises unique_violation (23505).
//
// This spec FAILS FIRST against the pre-wiring repository + pre-migration DB:
// without the index + P2002 translation the duplicate create SUCCEEDS (B), and
// stored source_system is the un-normalized raw string. Skipped unless
// ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const EXTERNAL_IDENTITY_INDEX = 'Requisition_external_identity_key';

// Glob the full requisition migration chain (sorted) so the T8-P1 partial-unique
// migration is applied without a hardcoded list (it sorts last chronologically).
function requisitionMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/requisition/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const SCOPES = ['requisition:create', 'requisition:edit'] as const;
const REQUEST_ID = '00000000-0000-4000-8000-0000000000t8';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T8-P1 canonical external-requisition identity — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: RequisitionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of requisitionMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      // is_hot is never set here, so gateSetPriority returns null before the
      // policy service is consulted — a throwing stub proves it is not called.
      const setPriorityStub = {
        decide: async () => {
          throw new Error('SetPriorityPolicyService.decide must not be called');
        },
      } as never;
      const transitionStub = {
        decide: async () => {
          throw new Error('RequisitionTransitionPolicyService.decide must not be called');
        },
      } as never;
      // No ContractAssignment rows are seeded — consuming_count is 0 and derived
      // availability equals total openings. Local stub avoids the placement schema.
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

    function createInput(overrides: Record<string, unknown>): never {
      return { title: 'VMS req', company_id: randomUUID(), ...overrides } as never;
    }

    async function create(tenant_id: string, overrides: Record<string, unknown>) {
      return repo.create({
        tenant_id,
        entered_by_id: randomUUID(),
        input: createInput(overrides),
        scopes: SCOPES,
        requestId: REQUEST_ID,
      });
    }

    async function storedSourceSystem(id: string): Promise<string | null> {
      const { rows } = await db.query(
        `SELECT source_system FROM requisition."Requisition" WHERE id = $1::uuid`,
        [id],
      );
      return (rows[0] as { source_system: string | null }).source_system;
    }

    it('B — duplicate (tenant, source_system, external_req_id) is rejected 409, case-variant collapses', async () => {
      const tenant = randomUUID();
      const first = await create(tenant, { source_system: 'Fieldglass', external_req_id: 'REQ-1' });
      // Normalization is stored (load-bearing for the index).
      expect(await storedSourceSystem(first.id)).toBe('fieldglass');

      // Exact duplicate → typed 409.
      await expect(
        create(tenant, { source_system: 'fieldglass', external_req_id: 'REQ-1' }),
      ).rejects.toMatchObject({ code: 'REQUISITION_EXTERNAL_IDENTITY_CONFLICT', statusCode: 409 });

      // Case-variant of the SAME provider → SAME canonical identity → also 409.
      await expect(
        create(tenant, { source_system: 'FIELDGLASS', external_req_id: 'REQ-1' }),
      ).rejects.toMatchObject({ code: 'REQUISITION_EXTERNAL_IDENTITY_CONFLICT', statusCode: 409 });
    });

    it('C — same external id under a different tenant is allowed', async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const a = await create(tenantA, { source_system: 'beeline', external_req_id: 'EXT-C' });
      const b = await create(tenantB, { source_system: 'beeline', external_req_id: 'EXT-C' });
      expect(a.id).not.toBe(b.id);
    });

    it('D — same external id under a different source_system is distinct', async () => {
      const tenant = randomUUID();
      const a = await create(tenant, { source_system: 'fieldglass', external_req_id: 'EXT-D' });
      const b = await create(tenant, { source_system: 'beeline', external_req_id: 'EXT-D' });
      expect(a.id).not.toBe(b.id);
    });

    it('E — requisitions with NO external identity remain valid, repeatedly (partial index)', async () => {
      const tenant = randomUUID();
      // No provenance at all.
      const m1 = await create(tenant, {});
      const m2 = await create(tenant, {});
      expect(m1.id).not.toBe(m2.id);
      // source_system tagged but NO external_req_id → not part of the partial index.
      const s1 = await create(tenant, { source_system: 'manual' });
      const s2 = await create(tenant, { source_system: 'manual' });
      expect(s1.id).not.toBe(s2.id);
    });

    it('co-presence — external_req_id without source_system is a 400 VALIDATION_ERROR', async () => {
      const tenant = randomUUID();
      await expect(create(tenant, { external_req_id: 'NO-SOURCE' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      });
    });

    it('F — the partial-unique index exists with the correct key + predicate, and enforces at the DB', async () => {
      const { rows } = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='requisition' AND indexname=$1`,
        [EXTERNAL_IDENTITY_INDEX],
      );
      expect(rows.length).toBe(1);
      const def = (rows[0] as { indexdef: string }).indexdef;
      expect(def).toContain('UNIQUE');
      expect(def).toContain('tenant_id');
      expect(def).toContain('source_system');
      expect(def).toContain('external_req_id');
      // Partial predicate — both provenance fields must be present.
      expect(def).toMatch(/WHERE .*source_system IS NOT NULL.*external_req_id IS NOT NULL/s);

      // Raw duplicate insert (bypassing the repository) raises unique_violation.
      const tenant = randomUUID();
      const insert = (id: string) =>
        db.query(
          `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, source_system, external_req_id, requisition_number)
           VALUES ($1::uuid,$2::uuid,'raw',$3::uuid,'fieldglass','RAW-1',
             (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id=$2::uuid))`,
          [id, tenant, randomUUID()],
        );
      await insert(randomUUID());
      await expect(insert(randomUUID())).rejects.toMatchObject({ code: '23505' });
    });
  },
);
