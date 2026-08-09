import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapacityProjectionRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RequisitionRepository } from '../lib/requisition.repository.js';

import { applyCapacityB2Migrations } from './_capacity-b2-harness.js';

// Track 4 / T4-B2 §6 — THE DROP-BOUNDARY proof (D-1, chronological RED-first). This
// is the LAST irreversible B2 boundary: the stored requisition.openings_available
// column is physically retired. The harness readdir-applies the WHOLE requisition
// migration chain, so it INCLUDES the dedicated drop migration once authored.
//
// RED (before the drop migration exists): the chain leaves the column in place, so
// the physical-retirement assertion FAILS specifically because the stored column
// still exists. GREEN (after the drop migration): information_schema no longer lists
// it, a requisition is created WITHOUT it, and the reader still returns the DERIVED
// openings_available. The public field survives; only the physical column is gone.

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T4-B2 §6 — stored openings_available column is PHYSICALLY RETIRED; availability is derived-only [real Postgres 17]',
  () => {
    let container: StartedPostgreSqlContainer;
    let reqPrisma: PrismaService;
    let placementPrisma: PlacementPrismaService;
    let repo: RequisitionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      await applyCapacityB2Migrations(url);

      reqPrisma = new PrismaService(url);
      await reqPrisma.$connect();
      placementPrisma = new PlacementPrismaService(url);
      await placementPrisma.$connect();
      repo = new RequisitionRepository(
        reqPrisma,
        {} as never,
        {} as never,
        new CapacityProjectionRepository(placementPrisma),
      );
    }, 180_000);

    afterAll(async () => {
      await reqPrisma?.$disconnect();
      await placementPrisma?.$disconnect();
      await container?.stop();
    });

    // ---- A. PHYSICAL RETIREMENT (the DROP-boundary RED) ----
    it('A: requisition."Requisition" has NO openings_available column after the full chain', async () => {
      const rows = (await reqPrisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'requisition' AND table_name = 'Requisition'
           AND column_name = 'openings_available'`,
      )) as Array<{ column_name: string }>;
      // RED before the drop migration exists (the column is still there → length 1).
      expect(rows).toHaveLength(0);
    });

    // ---- B. CREATE without the column ----
    it('B: a requisition row is created WITHOUT writing openings_available (column truly gone)', async () => {
      const tenant_id = randomUUID();
      const id = randomUUID();
      // Insert every remaining NOT-NULL-without-default column, but NOT
      // openings_available. Post-drop this succeeds; pre-drop the column exists
      // with a DEFAULT so this would also insert — the discriminating proof is (A).
      await reqPrisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number, openings)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)`,
        id,
        tenant_id,
        'drop-create',
        randomUUID(),
        9000,
        4,
      );
      const cnt = (await reqPrisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM requisition."Requisition" WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(cnt[0].n).toBe(1);
    });

    // ---- C. DETAIL reader returns DERIVED availability (no stored column) ----
    it('C: detail read returns derived openings_available (openings 4 - 1 active = 3)', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      await reqPrisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number, openings)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)`,
        requisition_id,
        tenant_id,
        'drop-detail',
        randomUUID(),
        9001,
        4,
      );
      await seedActive(placementPrisma, tenant_id, requisition_id, 1);
      const view = await repo.findByIdAdmin({ tenant_id, id: requisition_id });
      expect(view).not.toBeNull();
      expect(view!.openings_available).toBe(3);
      expect(view!.openings).toBe(4);
    });

    // ---- D. LIST reader returns DERIVED availability per row ----
    it('D: list read derives openings_available per row (one set-read)', async () => {
      const tenant_id = randomUUID();
      const rA = randomUUID();
      const rB = randomUUID();
      let n = 9100;
      for (const [id, openings] of [
        [rA, 5],
        [rB, 2],
      ] as const) {
        await reqPrisma.$executeRawUnsafe(
          `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number, openings)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)`,
          id,
          tenant_id,
          'drop-list',
          randomUUID(),
          n++,
          openings,
        );
      }
      await seedActive(placementPrisma, tenant_id, rA, 3); // 5 - 3 = 2
      const views = await repo.listForActor({
        tenant_id,
        visibility: {
          tenant_id,
          actor_user_id: randomUUID(),
          see_all_company: false,
          see_all_requisition: true,
          visible_client_ids: null,
        } as never,
        limit: 50,
      });
      const byId = new Map(views.map((v) => [v.id, v]));
      expect(byId.get(rA)!.openings_available).toBe(2);
      expect(byId.get(rB)!.openings_available).toBe(2); // 2 - 0
    });

    // ---- H/I. FULLY CONSUMED (0) and OVER-CAPACITY (public 0; signed < 0) ----
    it('H/I: fully-consumed derives 0; over-capacity derives public 0 with signed balance < 0', async () => {
      const tenant_id = randomUUID();
      const capacity = new CapacityProjectionRepository(placementPrisma);
      const full = randomUUID();
      const over = randomUUID();
      await seedActive(placementPrisma, tenant_id, full, 3);
      await seedActive(placementPrisma, tenant_id, over, 5);
      const pFull = await capacity.projectCapacity(tenant_id, full, 3); // 3 - 3
      expect(pFull.openings_available).toBe(0);
      expect(pFull.capacity_status).toBe('FULLY_CONSUMED');
      const pOver = await capacity.projectCapacity(tenant_id, over, 2); // 2 - 5
      expect(pOver.openings_available).toBe(0); // public floors
      expect(pOver.capacity_balance).toBe(-3); // signed truth preserved
      expect(pOver.capacity_status).toBe('OVER_CAPACITY');
    });

    // ---- J. ENDED assignment does NOT consume ----
    it('J: an ENDED assignment does not consume capacity', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const capacity = new CapacityProjectionRepository(placementPrisma);
      await seedActive(placementPrisma, tenant_id, requisition_id, 1);
      await seedEnded(placementPrisma, tenant_id, requisition_id, 2);
      const p = await capacity.projectCapacity(tenant_id, requisition_id, 4);
      expect(p.openings_available).toBe(3); // 4 - 1 active (2 ended ignored)
    });

    // ---- M. G1: openings_reserved 0, FULLY_RESERVED unreachable ----
    it('M: openings_reserved stays 0 and FULLY_RESERVED is unreachable', async () => {
      const tenant_id = randomUUID();
      const capacity = new CapacityProjectionRepository(placementPrisma);
      const statuses = new Set<string>();
      for (const [openings, active] of [
        [3, 0],
        [3, 1],
        [3, 3],
        [2, 5],
      ] as const) {
        const req = randomUUID();
        await seedActive(placementPrisma, tenant_id, req, active);
        const p = await capacity.projectCapacity(tenant_id, req, openings);
        expect(p.openings_reserved).toBe(0);
        statuses.add(p.capacity_status);
      }
      expect(statuses.has('FULLY_RESERVED')).toBe(false);
    });
  },
);

async function seedActive(
  prisma: PlacementPrismaService,
  tenant_id: string,
  requisition_id: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.contractAssignment.create({
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
}

async function seedEnded(
  prisma: PlacementPrismaService,
  tenant_id: string,
  requisition_id: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.contractAssignment.create({
      data: {
        id: randomUUID(),
        tenant_id,
        placement_process_id: randomUUID(),
        submittal_id: randomUUID(),
        requisition_id,
        talent_record_id: randomUUID(),
        started_at: new Date(),
        provenance: 'FORWARD',
        lifecycle_state: 'ENDED',
        end_reason: 'COMPLETED',
        company_id: randomUUID(),
      },
    });
  }
}
