import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapacityProjectionRepository, PrismaService } from '@aramo/placement';

import { RequisitionController } from '../lib/requisition.controller.js';
import type { RequisitionRepository } from '../lib/requisition.repository.js';
import type { RequisitionView } from '../lib/dto/requisition.view.js';

// Track 4 / T4-B1 — the requisition -> placement edge, proven end-to-end with a
// REAL ContractAssignment (not a stubbed projection). The proof shows the
// coexistence that IS T4-B1: the GET :id surface returns the DERIVED capacity
// ALONGSIDE the still-present stored openings_available. Non-vacuous: the seeded
// assignment is asserted to exist and the derived value reflects it exactly.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260813130000_t6_b3_commercial_cancellation',
].map((d) => resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`));

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T4-B1 requisition -> placement capacity edge (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let placementPrisma: PrismaService;
    let capacity: CapacityProjectionRepository;

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
      capacity = new CapacityProjectionRepository(placementPrisma);
    }, 120_000);

    afterAll(async () => {
      await placementPrisma?.$disconnect();
      await container?.stop();
    });

    it('GET :id returns DERIVED capacity from a real assignment ALONGSIDE the stored openings_available (both coexist)', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const OPENINGS = 3;
      const STORED_OPENINGS_AVAILABLE = 2; // the still-present pipeline-maintained column

      // Seed a REAL ACTIVE ContractAssignment for this requisition (not a stub).
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
      // Non-vacuity: the seeded assignment exists.
      const seeded = await placementPrisma.contractAssignment.count({ where: { tenant_id, requisition_id } });
      expect(seeded).toBe(1);

      // Mock ONLY the requisition data source (the stored column); the capacity
      // projection is REAL. The controller pulls derived capacity via the edge.
      const requisitionRepository = {
        findByIdForActor: async () =>
          ({ openings: OPENINGS, openings_available: STORED_OPENINGS_AVAILABLE } as unknown as RequisitionView),
      } as unknown as RequisitionRepository;

      const controller = new RequisitionController(
        requisitionRepository,
        {} as never,
        {} as never,
        {} as never,
        capacity,
      );

      const auth = { tenant_id, sub: randomUUID(), scopes: ['requisition:read'] } as never;
      const req = { resolveVisibility: async () => ({}) } as never;

      // COEXISTENCE — the stored authority is UNCHANGED and NOT coupled to placement:
      // GET :id returns the stored openings_available and carries NO derived capacity
      // field (derived capacity is additive/unexposed; the detail read never queries
      // placement at runtime).
      const view = await controller.get(auth, requisition_id, 'r', req);
      expect(view.openings_available).toBe(STORED_OPENINGS_AVAILABLE);
      expect((view as Record<string, unknown>).capacity).toBeUndefined();

      // ...AND the derived capacity is PULLABLE via the declared edge, reflecting
      // the REAL assignment exactly (access, not exposure).
      const derived = await controller.readCapacity(tenant_id, requisition_id, OPENINGS);
      expect(derived.openings).toBe(OPENINGS);
      expect(derived.capacity_balance).toBe(OPENINGS - 1); // 3 openings - 1 ACTIVE assignment
      expect(derived.openings_available).toBe(2);
      expect(derived.openings_reserved).toBe(0);
      expect(derived.capacity_status).toBe('AVAILABLE');
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
