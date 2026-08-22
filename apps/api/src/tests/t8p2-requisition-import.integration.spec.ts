import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveCapacity } from '@aramo/placement';
import {
  RequisitionRepository,
  RequisitionPrismaService,
} from '@aramo/requisition';
import { ImportService, ImportPrismaService } from '@aramo/import';
import type { RunRequisitionImportRequestDto } from '@aramo/import';

// T8-P2 — provider-neutral canonical requisition ingestion, exercised against
// real Postgres 17 at the service+DB layer (constructs ImportService +
// RequisitionRepository directly, like requisition-concurrency). Lives in
// apps/api (an integration root; libs/import is not a lib-local root).
//
// Proof matrix (directive §19):
//   A create-with-provenance · B replay-does-not-duplicate ·
//   C cross-tenant isolation · E lifecycle (gated refused, mapped applied) ·
//   F openings→stored-total-only · G no openings_available persistence ·
//   I req-level commercial via gated fields · J batch accounting ·
//   K per-record deterministic failure · L import audit + REQUISITION_IMPORTED.
//
// The genuinely NEW validation/mapping logic was authored RED-first at the unit
// layer (requisition-import.mapper.spec.ts). This spec VERIFIES the orchestration
// (reusing the proven runImport batch pattern + createForImport + T8-P1 identity).
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
// compensation:edit:bill is required to import a requisition-level bill rate
// (boundary I — the import honors the existing gated-field semantics).
const EDIT_SCOPES = ['requisition:edit', 'compensation:edit:bill'] as const;
const REQUEST_ID = '00000000-0000-4000-8000-0000000000t8';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
// Glob requisition (incl. T8-P1 external-identity + T4-B2 openings drop) + import.
const MIGRATIONS = [...migrationsFor('requisition'), ...migrationsFor('import')];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T8-P2 canonical requisition import — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let reqPrisma: RequisitionPrismaService;
    let importPrisma: ImportPrismaService;
    let service: ImportService;

    let savedThreshold: string | undefined;
    beforeAll(async () => {
      // Threshold 100% so per-record failures are RECORDED (partial-commit) — the
      // P2 proof. The reject-on-threshold path is the reused runImport behavior
      // (characterization), loaded by the ImportService ctor below, so set first.
      savedThreshold = process.env['IMPORT_FAILURE_THRESHOLD_PCT'];
      process.env['IMPORT_FAILURE_THRESHOLD_PCT'] = '100';
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      reqPrisma = new RequisitionPrismaService(url);
      await reqPrisma.$connect();
      importPrisma = new ImportPrismaService(url);
      await importPrisma.$connect();

      const setPriorityStub = { decide: async () => { throw new Error('no'); } } as never;
      const transitionStub = { decide: async () => { throw new Error('no'); } } as never;
      const capacityStub = {
        projectCapacity: async (_t: string, _r: string, openings: number) =>
          deriveCapacity({ openings, consuming_count: 0 }),
        countActiveByRequisitionIds: async () => new Map<string, number>(),
      } as never;
      const reqRepo = new RequisitionRepository(reqPrisma, setPriorityStub, transitionStub, capacityStub, { deriveByRequisitionIds: async () => new Map() } as never);
      // Company/Contact/TalentRecord repos are never reached for a requisition
      // import; pass inert stubs.
      service = new ImportService(
        importPrisma as never,
        {} as never,
        {} as never,
        reqRepo as never,
        {} as never,
      );
    }, 120_000);

    afterAll(async () => {
      await reqPrisma?.onModuleDestroy?.();
      await importPrisma?.onModuleDestroy?.();
      await db?.end();
      await container?.stop();
      if (savedThreshold === undefined) delete process.env['IMPORT_FAILURE_THRESHOLD_PCT'];
      else process.env['IMPORT_FAILURE_THRESHOLD_PCT'] = savedThreshold;
    }, 60_000);

    function run(tenant_id: string, input: RunRequisitionImportRequestDto) {
      return service.runCanonicalRequisitionImport({
        tenant_id,
        imported_by_id: uuidv7(),
        input,
        scopes: EDIT_SCOPES,
        requestId: REQUEST_ID,
      });
    }

    async function reqRows(tenant_id: string) {
      const { rows } = await db.query(
        `SELECT id, title, status, openings, source_system, external_req_id, import_batch_id, bill_rate_amount
         FROM requisition."Requisition" WHERE tenant_id = $1::uuid ORDER BY requisition_number`,
        [tenant_id],
      );
      return rows as Array<Record<string, unknown>>;
    }
    async function failures(batchId: string) {
      const { rows } = await db.query(
        `SELECT row_number, failure_reason FROM import."ImportFailure" WHERE import_batch_id = $1::uuid ORDER BY row_number`,
        [batchId],
      );
      return rows as Array<{ row_number: number; failure_reason: string }>;
    }
    async function lifecycleReasons(reqId: string) {
      const { rows } = await db.query(
        `SELECT reason_code, origin, previous_status FROM requisition."RequisitionLifecycleEvent" WHERE requisition_id = $1::uuid`,
        [reqId],
      );
      return rows as Array<{ reason_code: string; origin: string; previous_status: string | null }>;
    }

    it('A/L — creates a requisition with canonical provenance + REQUISITION_IMPORTED audit', async () => {
      const tenant = uuidv7();
      const batch = await run(tenant, {
        source_label: 'vms-batch-A',
        records: [
          { source_system: 'Fieldglass', external_req_id: 'REQ-A', title: 'Engineer', openings: 3, company_id: uuidv7() },
        ],
      });
      expect(batch.status).toBe('committed');
      expect(batch.success_count).toBe(1);
      expect(batch.failure_count).toBe(0);
      expect(batch.target_entity).toBe('requisition');

      const rows = await reqRows(tenant);
      expect(rows.length).toBe(1);
      expect(rows[0]['source_system']).toBe('fieldglass'); // canonicalized
      expect(rows[0]['external_req_id']).toBe('REQ-A');
      expect(rows[0]['status']).toBe('open'); // default
      expect(rows[0]['openings']).toBe(3);
      expect(rows[0]['import_batch_id']).toBe(batch.id);

      // L — audit: the created req carries the REQUISITION_IMPORTED lifecycle event.
      const ev = await lifecycleReasons(rows[0]['id'] as string);
      expect(ev.some((e) => e.reason_code === 'REQUISITION_IMPORTED' && e.origin === 'integration' && e.previous_status === null)).toBe(true);
    });

    it('B — exact replay of the same external identity does NOT duplicate (deterministic reject)', async () => {
      const tenant = uuidv7();
      const first = await run(tenant, {
        source_label: 'vms-B1',
        records: [{ source_system: 'beeline', external_req_id: 'REQ-B', title: 'A', openings: 1, company_id: uuidv7() }],
      });
      expect(first.success_count).toBe(1);

      // Re-import the SAME identity (case-variant to prove canonical collapse).
      const replay = await run(tenant, {
        source_label: 'vms-B2',
        records: [{ source_system: 'BEELINE', external_req_id: 'REQ-B', title: 'A2', openings: 1, company_id: uuidv7() }],
      });
      expect(replay.success_count).toBe(0);
      expect(replay.failure_count).toBe(1);
      const f = await failures(replay.id);
      expect(f[0]?.failure_reason).toBe('REQUISITION_EXTERNAL_IDENTITY_CONFLICT');

      // Only ONE requisition row for the identity.
      expect((await reqRows(tenant)).length).toBe(1);
    });

    it('C — same external identity under a different tenant is allowed', async () => {
      const tenantA = uuidv7();
      const tenantB = uuidv7();
      const rec = { source_system: 'coupa', external_req_id: 'REQ-C', title: 'X', openings: 1, company_id: uuidv7() };
      const a = await run(tenantA, { source_label: 's', records: [rec] });
      const b = await run(tenantB, { source_label: 's', records: [rec] });
      expect(a.success_count).toBe(1);
      expect(b.success_count).toBe(1);
    });

    it('E — a mapped non-gated status is applied; a gated status is rejected per-record', async () => {
      const tenant = uuidv7();
      const batch = await run(tenant, {
        source_label: 'vms-E',
        records: [
          { source_system: 'oracle', external_req_id: 'E-OK', title: 'ok', openings: 1, company_id: uuidv7(), external_status: 'on_hold' },
          { source_system: 'oracle', external_req_id: 'E-GATE', title: 'gate', openings: 1, company_id: uuidv7(), external_status: 'draft' },
        ],
      });
      expect(batch.success_count).toBe(1);
      expect(batch.failure_count).toBe(1);
      expect(batch.status).toBe('partially_committed');
      const rows = await reqRows(tenant);
      expect(rows.find((r) => r['external_req_id'] === 'E-OK')?.['status']).toBe('on_hold');
      const f = await failures(batch.id);
      expect(f[0]?.failure_reason).toBe('GATED_STATUS_NOT_IMPORTABLE');
    });

    it('F/G — openings maps to the stored total only; no openings_available column exists', async () => {
      const tenant = uuidv7();
      await run(tenant, {
        source_label: 'vms-F',
        records: [{ source_system: 'fieldglass', external_req_id: 'REQ-F', title: 'F', openings: 7, company_id: uuidv7() }],
      });
      expect((await reqRows(tenant))[0]?.['openings']).toBe(7);
      // G — the stored availability column was dropped (T4-B2); import never revives it.
      const { rows } = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='requisition' AND table_name='Requisition' AND column_name='openings_available'`,
      );
      expect(rows.length).toBe(0);
    });

    it('I/J/K — req-level commercial mapped; mixed batch accounts success/failure deterministically', async () => {
      const tenant = uuidv7();
      const batch = await run(tenant, {
        source_label: 'vms-I',
        records: [
          { source_system: 'fieldglass', external_req_id: 'I-OK', title: 'ok', openings: 1, company_id: uuidv7(), bill_rate_amount: '120.00', bill_rate_currency: 'USD', bill_rate_period: 'HOURLY' },
          { source_system: 'fieldglass', external_req_id: 'I-BAD', title: 'bad', openings: -1, company_id: uuidv7() },
          { source_system: 'fieldglass', external_req_id: 'I-UNSUP', title: 'unsup', openings: 1, company_id: uuidv7(), worker_pay_rate: '85' } as never,
        ],
      });
      expect(batch.success_count).toBe(1);
      expect(batch.failure_count).toBe(2);
      const okRow = (await reqRows(tenant)).find((r) => r['external_req_id'] === 'I-OK');
      expect(Number(okRow?.['bill_rate_amount'])).toBe(120); // Decimal(12,2) stored (pg returns a string)
      const f = await failures(batch.id);
      const reasons = f.map((x) => x.failure_reason).sort();
      expect(reasons).toEqual(['INVALID_OPENINGS', 'UNSUPPORTED_FIELD']);
    });
  },
);
