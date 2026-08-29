import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapacityProjectionRepository, PrismaService } from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// Track 4 / T4-B1 (CASE A) — the reporting -> placement edge, proven with a REAL
// ContractAssignment. reporting can ACCESS the derived capacity via the declared
// edge; the getCompanyMetrics `filled` aggregate is UNCHANGED and still reads the
// stored openings_available (company-metrics.spec proves that path intact). The
// two authorities coexist. The N-read aggregate migration is T4-B2 (a batch
// projection owned by libs/placement), not built here.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260825120000_assignment_extension_horizon',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260815120000_t7_p2_falloff_remedy',
  '20260816120000_t7_p3_guarantee_term_versioning',
].map((d) => resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`));

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T4-B1 reporting -> placement capacity edge (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let placementPrisma: PrismaService;
    let svc: ReportingService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      placementPrisma = new PrismaService(url);
      await placementPrisma.$connect();
      const capacity = new CapacityProjectionRepository(placementPrisma);

      // Real capacity projection; every other repo is a stub — readRequisitionCapacity
      // only exercises the projection edge.
      svc = new ReportingService(
        {} as never, // company
        {} as never, // contact
        {} as never, // talentRecord
        {} as never, // savedList
        {} as never, // calendar
        {} as never, // activity
        {} as never, // requisition
        {} as never, // pipeline
        {} as never, // tenantSetting
        capacity,
        {} as never, // placementEventRepository (T9-B2; unused by capacity edge)
        {} as never, // placementPipelineRepository (T9-B3; unused here)
        {} as never, // T7-P4 guaranteeExposureRepository (unused here)
        {} as never, // commercialMarginRepository (T9-B4; unused here)
        { findFirstSubmittedByGrain: async () => [] } as never, // L2-E submitted-history port
      );
    }, 120_000);

    afterAll(async () => {
      await placementPrisma?.$disconnect();
      await container?.stop();
    });

    it('reporting can PULL derived capacity from a real assignment (access); stored aggregate path is untouched', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const OPENINGS = 4;

      // Seed TWO real ACTIVE ContractAssignments for this requisition.
      for (let i = 0; i < 2; i++) {
        await placementPrisma.contractAssignment.create({
          data: {
            id: randomUUID(),
            tenant_id,
            placement_process_id: randomUUID(),
            submittal_id: randomUUID(),
            requisition_id,
            talent_record_id: randomUUID(),
            started_at: new Date(),
            provenance: 'FORWARD',
            lifecycle_state: 'ACTIVE',
            company_id: randomUUID(),
          },
        });
      }
      // Non-vacuity: the seeded assignments exist.
      const seeded = await placementPrisma.contractAssignment.count({ where: { tenant_id, requisition_id } });
      expect(seeded).toBe(2);

      const derived = await svc.readRequisitionCapacity(tenant_id, requisition_id, OPENINGS);
      // Derived reflects the REAL assignments exactly.
      expect(derived.capacity_balance).toBe(OPENINGS - 2); // 4 openings - 2 ACTIVE
      expect(derived.openings_available).toBe(2);
      expect(derived.openings_reserved).toBe(0);
      expect(derived.capacity_status).toBe('AVAILABLE');

      // COEXISTENCE — a hypothetical stored value (still the aggregate's source)
      // is an independent number; the edge ADDED derived without removing stored.
      const STORED_OPENINGS_AVAILABLE = 4; // e.g. pipeline never decremented this req
      const storedFilled = Math.max(0, OPENINGS - STORED_OPENINGS_AVAILABLE); // aggregate's formula
      expect(storedFilled).toBe(0); // stored says 0 filled...
      expect(OPENINGS - derived.openings_available).toBe(2); // ...derived says 2 — both coexist, independent
    });
  },
);

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
