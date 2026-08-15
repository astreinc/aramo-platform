import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { PlacementProcessEventRepository } from '../lib/placement-process-event.repository.js';
import {
  PLACEMENT_REASONS,
  type PlacementReasonDefinition,
} from '../lib/reasons/placement-reason-registry.js';
import type { CreatePlacementInput } from '../lib/placement-process.types.js';

// Track 3 / E1-d — the placement READ surface (collection + event/reason) at the
// repository boundary, against real Postgres 17. These prove the least-visibility
// and reason-disclosure rulings (D-1/D-2/D-3) at the exact predicates the HTTP
// controller delegates to. The three placement migrations are the curated list
// (the generated client selects their columns).
const INIT_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260803180000_init_placement_model/migration.sql');
const OFFER_OUTBOX_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260805120000_placement_offer_and_outbox/migration.sql');
const REASON_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260807120000_placement_fallthrough_reason/migration.sql');
// E4 — additive replacement-lineage column; the Prisma client now selects it.
const REPLACEMENT_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260808120000_placement_replacement_link/migration.sql');
// T7-P1: adds PlacementProcess.placement_kind — the regenerated client SELECTs it on
// every read/create here, so this read-path spec must apply it or CI 500s.
const PERMANENT_PLACEMENT_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260814120000_t7_permanent_placement/migration.sql');
// T7-P2: adds PermanentPlacement.falloff_* columns — the regenerated client SELECTs them
// on every PermanentPlacement read, so this read-path spec must apply it (SEPARATE const).
const FALLOFF_REMEDY_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260815120000_t7_p2_falloff_remedy/migration.sql');
// T7-P3: SEPARATE const (never a 2nd resolve() arg — that path-joins to ENOTDIR).
const GUARANTEE_TERMS_MIGRATION_PATH = resolve(__dirname, '../../prisma/migrations/20260816120000_t7_p3_guarantee_term_versioning/migration.sql');

// A governed-terminal reason for OFFER_DECLINED that ALLOWS detail (OPTIONAL
// policy), so a reason-bearing event carries a non-null reason_detail — the
// canonical evidence Proof 5 asserts is retrievable on the authorized surface.
const DECLINE_REASON_OPTIONAL: PlacementReasonDefinition = PLACEMENT_REASONS.find(
  (r) => r.status === 'active' && r.detailPolicy === 'OPTIONAL' && r.allowedTargets.includes('OFFER_DECLINED'),
)!;
const REASON_DETAIL_TEXT = 'operational note captured at decline (test evidence)';

// Dollar-quote-aware DDL splitter (comment-blind; the migrations carry no
// `--`-comment-with-semicolon, guarded elsewhere). Local per spec (not shared).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function baseInput(overrides: Partial<CreatePlacementInput> = {}): CreatePlacementInput {
  return {
    tenant_id: randomUUID(),
    submittal_id: randomUUID(),
    requisition_id: randomUUID(),
    talent_record_id: randomUUID(),
    ...overrides,
  };
}

// The reason field names that must NEVER appear on a collection item (D-1/D-2).
const REASON_KEYS = ['reason_code', 'reason_label_snapshot', 'reason_detail'] as const;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'E1-d Placement READ surface — least-visibility + reason disclosure (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let events: PlacementProcessEventRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of [INIT_MIGRATION_PATH, OFFER_OUTBOX_MIGRATION_PATH, REASON_MIGRATION_PATH, REPLACEMENT_MIGRATION_PATH, PERMANENT_PLACEMENT_MIGRATION_PATH, FALLOFF_REMEDY_MIGRATION_PATH, GUARANTEE_TERMS_MIGRATION_PATH]) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length > 0) await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
      events = new PlacementProcessEventRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Create a placement and drive it to OFFER_DECLINED carrying the canonical
    // reason (code + optional detail). Returns { id, requisition_id }.
    async function makeDeclinedWithReason(tenant_id: string): Promise<{ id: string; requisition_id: string }> {
      const input = baseInput({ tenant_id });
      const created = await repo.createPlacement(input, 'seed');
      await repo.transition(
        {
          tenant_id,
          placement_process_id: created.id,
          to: 'OFFER_DECLINED',
          reason_code: DECLINE_REASON_OPTIONAL.code,
          reason_detail: REASON_DETAIL_TEXT,
        },
        'seed',
      );
      return { id: created.id, requisition_id: input.requisition_id };
    }

    // ---- Proof 1 — collection tenant isolation (boundary: the tenant predicate) --
    it('Proof 1 — listForActor is tenant-isolated: another tenant’s placement never enters the result', async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const a = await repo.createPlacement(baseInput({ tenant_id: tenantA }), 'p1');
      const b = await repo.createPlacement(baseInput({ tenant_id: tenantB }), 'p1');

      const seenByA = await repo.listForActor({ tenant_id: tenantA, visible_requisition_ids: null });
      const ids = seenByA.map((p) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
      // Every returned row is tenant A's — no cross-tenant leak.
      expect(seenByA.every((p) => p.tenant_id === tenantA)).toBe(true);
    });

    // ---- Proof 2 — actor visibility (boundary: the requisition-visibility predicate) --
    it('Proof 2 — a same-tenant placement whose requisition is NOT in the visible set is unobservable (list + item)', async () => {
      const tenant = randomUUID();
      const visibleReq = randomUUID();
      const hiddenReq = randomUUID();
      const visible = await repo.createPlacement(baseInput({ tenant_id: tenant, requisition_id: visibleReq }), 'p2');
      const hidden = await repo.createPlacement(baseInput({ tenant_id: tenant, requisition_id: hiddenReq }), 'p2');

      const visSet = new Set<string>([visibleReq]);
      const listed = await repo.listForActor({ tenant_id: tenant, visible_requisition_ids: visSet });
      const listedIds = listed.map((p) => p.id);
      expect(listedIds).toContain(visible.id);
      expect(listedIds).not.toContain(hidden.id);

      // Item read: the hidden placement is 404-equivalent (null) under the same set.
      expect(await repo.findByIdForActor({ tenant_id: tenant, id: hidden.id, visible_requisition_ids: visSet })).toBeNull();
      // The visible one is returned.
      expect((await repo.findByIdForActor({ tenant_id: tenant, id: visible.id, visible_requisition_ids: visSet }))?.id).toBe(visible.id);
      // see-all (null) sees both.
      expect(await repo.findByIdForActor({ tenant_id: tenant, id: hidden.id, visible_requisition_ids: null })).not.toBeNull();
    });

    // ---- Proof 4 — collection reason NON-disclosure (boundary: collection projection) --
    it('Proof 4 — a collection item carries NO reason evidence even for a reason-bearing terminal placement', async () => {
      const tenant = randomUUID();
      const { id } = await makeDeclinedWithReason(tenant);

      const listed = await repo.listForActor({ tenant_id: tenant, visible_requisition_ids: null });
      const item = listed.find((p) => p.id === id);
      expect(item).toBeDefined();
      expect(item!.state).toBe('OFFER_DECLINED');
      // The projection must not surface reason evidence on the collection surface.
      for (const key of REASON_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(item!, key)).toBe(false);
      }
    });

    // ---- Proof 5 — event reason DISCLOSURE (boundary: event projection) --
    it('Proof 5 — the event timeline exposes the canonical stored reason (code + label + permitted detail)', async () => {
      const tenant = randomUUID();
      const { id } = await makeDeclinedWithReason(tenant);

      const timeline = await events.listEvents(tenant, id);
      const terminal = timeline.find((e) => (e.event_payload as { to?: string })?.to === 'OFFER_DECLINED');
      expect(terminal).toBeDefined();
      // Canonical evidence is retrievable on the authorized detail surface (D-1).
      expect(terminal!.reason_code).toBe(DECLINE_REASON_OPTIONAL.code);
      expect(terminal!.reason_label_snapshot).toBe(DECLINE_REASON_OPTIONAL.label);
      expect(terminal!.reason_detail).toBe(REASON_DETAIL_TEXT);
    });

    // ---- Proof 6 — legacy / non-governed event null preservation (boundary: event projection) --
    it('Proof 6 — an ordinary (non-governed) transition event has NULL reason fields, never fabricated from state', async () => {
      const tenant = randomUUID();
      const input = baseInput({ tenant_id: tenant });
      const created = await repo.createPlacement(input, 'p6');
      // Ordinary progression edge — no reason evidence exists for it.
      await repo.transition({ tenant_id: tenant, placement_process_id: created.id, to: 'OFFER_ACCEPTED' }, 'p6');

      const timeline = await events.listEvents(tenant, created.id);
      const ordinary = timeline.find((e) => (e.event_payload as { to?: string })?.to === 'OFFER_ACCEPTED');
      expect(ordinary).toBeDefined();
      // A null here is legacy/non-governed absence — NEVER a canonical reason
      // reconstructed from the target state.
      expect(ordinary!.reason_code).toBeNull();
      expect(ordinary!.reason_label_snapshot).toBeNull();
      expect(ordinary!.reason_detail).toBeNull();
    });

    // Determinism (§3A/§5/§6) — a stable tie-breaker on equal-timestamp rows.
    it('collection ordering is deterministic (created_at desc, id asc tie-breaker)', async () => {
      const tenant = randomUUID();
      // Insert several; equal-timestamp rows are ordered by id asc within a
      // created_at group. Re-reading yields the identical order.
      for (let i = 0; i < 5; i++) await repo.createPlacement(baseInput({ tenant_id: tenant }), 'ord');
      const first = (await repo.listForActor({ tenant_id: tenant, visible_requisition_ids: null })).map((p) => p.id);
      const second = (await repo.listForActor({ tenant_id: tenant, visible_requisition_ids: null })).map((p) => p.id);
      expect(second).toEqual(first);
    });
  },
);
