import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { CapacityProjectionRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  RequisitionRepository,
  decodeRequisitionCursor,
  encodeRequisitionCursor,
  parseRequisitionNumber,
} from '../lib/requisition.repository.js';

import { applyCapacityB2Migrations } from './_capacity-b2-harness.js';

// ATS-QA-1 I-1 (D4; Directive v1.0 LOCKED §4 I-1) — the requisition PICKER read on real
// Postgres 17: keyset paging reaches EVERY visible requisition (no fixed 50 cap), the
// status filter and title-or-number search narrow within visibility, and visibility is
// never widened (an actor without see-all and without assignment/client access sees
// nothing; another tenant's rows never appear).

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATS-QA-1 D4 — requisition picker paging + search + status filter [real Postgres 17]',
  () => {
    let container: StartedPostgreSqlContainer;
    let reqPrisma: PrismaService;
    let placementPrisma: PlacementPrismaService;
    let repo: RequisitionRepository;
    const tenant_id = randomUUID();
    const otherTenant = randomUUID();
    const seeAll = (t: string) =>
      ({ tenant_id: t, actor_user_id: randomUUID(), see_all_company: false, see_all_requisition: true, visible_client_ids: null }) as never;
    const noAccess = (t: string) =>
      ({ tenant_id: t, actor_user_id: randomUUID(), see_all_company: false, see_all_requisition: false, visible_client_ids: [] }) as never;

    async function seed(t: string, title: string, number: number, status: string, createdAt: Date): Promise<string> {
      const id = randomUUID();
      await reqPrisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number, openings, status, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 1, $6::requisition."RecruitingStatus", $7)`,
        id,
        t,
        title,
        randomUUID(),
        number,
        status,
        createdAt,
      );
      return id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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
        { deriveByRequisitionIds: async () => new Map() } as never,
      );
      // 60 open requisitions (beyond the legacy 50 cap), 1 old on_hold, 1 draft, plus 3 in
      // another tenant. Distinct created_at so the keyset order is deterministic.
      const base = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 60; i++) await seed(tenant_id, `Engineer ${i}`, 1000 + i, 'open', new Date(base + i * 60_000));
      await seed(tenant_id, 'Legacy Data Architect', 999, 'on_hold', new Date(base - 86_400_000));
      await seed(tenant_id, 'Draft role', 2000, 'draft', new Date(base + 100 * 60_000));
      for (let i = 0; i < 3; i++) await seed(otherTenant, `Other ${i}`, 1000 + i, 'open', new Date(base + i * 60_000));
    }, 180_000);

    afterAll(async () => {
      await reqPrisma?.$disconnect();
      await placementPrisma?.$disconnect();
      await container?.stop();
    });

    it('keyset paging walks every visible requisition with no fixed cap, newest first, no duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await repo.listForActorPaged({ tenant_id, visibility: seeAll(tenant_id), page_size: 25, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.next_cursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(seen).toHaveLength(62);
      expect(new Set(seen).size).toBe(62);
      expect(pages).toBe(3);
    });

    it('status filter narrows (picker statuses open, on_hold, lead) and finds the old on_hold requisition', async () => {
      const all: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repo.listForActorPaged({
          tenant_id,
          visibility: seeAll(tenant_id),
          statuses: ['open', 'on_hold', 'lead'],
          page_size: 100,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...page.items.map((r) => r.title));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(all).toHaveLength(61);
      expect(all).toContain('Legacy Data Architect');
      expect(all).not.toContain('Draft role');
    });

    it('search matches the title or the requisition number (REQ-999, 999)', async () => {
      for (const q of ['legacy data', 'REQ-999', '999', '#999']) {
        const page = await repo.listForActorPaged({ tenant_id, visibility: seeAll(tenant_id), q });
        expect(page.items.map((r) => r.title), q).toEqual(['Legacy Data Architect']);
      }
    });

    it('never widens visibility: no access → nothing; another tenant never appears', async () => {
      const none = await repo.listForActorPaged({ tenant_id, visibility: noAccess(tenant_id) });
      expect(none.items).toEqual([]);
      const other = await repo.listForActorPaged({ tenant_id: otherTenant, visibility: seeAll(otherTenant), page_size: 100 });
      expect(other.items.map((r) => r.title).sort()).toEqual(['Other 0', 'Other 1', 'Other 2']);
    });

    it('a malformed cursor is the first page, never an error', async () => {
      const page = await repo.listForActorPaged({ tenant_id, visibility: seeAll(tenant_id), cursor: 'not-a-cursor', page_size: 5 });
      expect(page.items).toHaveLength(5);
    });

    it('helpers: number parsing and cursor round-trip', () => {
      expect(parseRequisitionNumber('REQ-1015')).toBe(1015);
      expect(parseRequisitionNumber('req 7')).toBe(7);
      expect(parseRequisitionNumber('engineer')).toBeNull();
      const d = new Date('2026-01-01T00:00:00.000Z');
      const id = randomUUID();
      expect(decodeRequisitionCursor(encodeRequisitionCursor(d, id))).toEqual({ created_at: d, id });
      expect(decodeRequisitionCursor('%%%')).toBeNull();
    });
  },
);
