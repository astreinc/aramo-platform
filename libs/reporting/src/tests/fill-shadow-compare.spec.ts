import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// Lane 2 / L2-G (Decision 2 / Rule C) — the shadow-compare DIAGNOSTIC. Proves the exact
// classification of the legacy pipeline `placed` fill vs the canonical PlacementProcess-
// established fill, per requisition: {agree, legacy_only, canonical_only, diverge}, each
// carrying both counts + both first instants + provenance. Also proves it is
// DIAGNOSTIC-ONLY: it emits classified evidence with NO verdict/boolean and does not feed
// the canonical readers (getFillPerformance/getPlacementCount touch ONLY readFillCohort).

const TENANT = 't-1';
const D = (iso: string): Date => new Date(iso);

function makeService(opts: {
  reqs: ReadonlyArray<{ id: string }>;
  legacy: ReadonlyArray<{ requisition_id: string; talent_record_id: string; first_placed_at: Date }>;
  canonical: ReadonlyArray<{ requisition_id: string; talent_record_id: string; first_established_at: Date }>;
}) {
  const requisitionRepository = {
    listForActor: vi.fn().mockResolvedValue(opts.reqs),
    // getFillPerformance reads its cohort via listCohortForActor (openings needed).
    listCohortForActor: vi
      .fn()
      .mockResolvedValue(opts.reqs.map((r) => ({ ...r, openings: 1, status: 'open', created_at: D('2026-05-01T00:00:00Z') }))),
  };
  const listFirstPlacedByRequisitions = vi.fn().mockResolvedValue(opts.legacy);
  const pipelineRepository = { listFirstPlacedByRequisitions };
  const readFillCohort = vi.fn().mockResolvedValue(
    opts.canonical.map((c, i) => ({
      requisition_id: c.requisition_id,
      talent_record_id: c.talent_record_id,
      first_placement_process_id: `pp-${String(i)}`,
      first_established_at: c.first_established_at,
      first_started_at: null,
    })),
  );
  const placementEventRepository = { readFillCohort };
  const stub = {} as never;
  const svc = new ReportingService(
    stub, stub, stub, stub, stub, stub,
    requisitionRepository as never,
    pipelineRepository as never,
    stub, // tenantSettingRepository
    stub, // capacity
    placementEventRepository as never, // readFillCohort
    stub, // placementPipelineRepository
    {} as never, // guaranteeExposureRepository
    stub, // commercialMarginRepository
    { findFirstSubmittedByGrain: async () => [] } as never,
    { findFirstInterviewByGrain: async () => [] } as never, // L2-I D4b interview-history port
  );
  return { svc, listFirstPlacedByRequisitions, readFillCohort };
}

const actor = {
  tenant_id: TENANT,
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

describe('ReportingService.getFillShadowCompare — Rule-C classification', () => {
  it('classifies agree / legacy_only / canonical_only / diverge with counts + instants', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r-agree' }, { id: 'r-legacy' }, { id: 'r-canon' }, { id: 'r-diverge' }],
      legacy: [
        // r-agree: same single talent + same instant on both sides
        { requisition_id: 'r-agree', talent_record_id: 'ta', first_placed_at: D('2026-05-10T00:00:00Z') },
        // r-legacy: placed but NO established placement
        { requisition_id: 'r-legacy', talent_record_id: 'tl', first_placed_at: D('2026-05-01T00:00:00Z') },
        // r-diverge: legacy has TWO talents; canonical has one
        { requisition_id: 'r-diverge', talent_record_id: 'td1', first_placed_at: D('2026-05-02T00:00:00Z') },
        { requisition_id: 'r-diverge', talent_record_id: 'td2', first_placed_at: D('2026-05-03T00:00:00Z') },
      ],
      canonical: [
        { requisition_id: 'r-agree', talent_record_id: 'ta', first_established_at: D('2026-05-10T00:00:00Z') },
        // r-canon: established but NO placed mirror
        { requisition_id: 'r-canon', talent_record_id: 'tc', first_established_at: D('2026-05-20T00:00:00Z') },
        { requisition_id: 'r-diverge', talent_record_id: 'td1', first_established_at: D('2026-05-02T00:00:00Z') },
      ],
    });

    const rows = await svc.getFillShadowCompare(actor);
    const byReq = new Map(rows.map((r) => [r.requisition_id, r]));

    expect(byReq.get('r-agree')).toMatchObject({
      classification: 'agree',
      legacy_count: 1,
      canonical_count: 1,
      legacy_first_instant: '2026-05-10T00:00:00.000Z',
      canonical_first_instant: '2026-05-10T00:00:00.000Z',
      legacy_fill_source: 'PIPELINE_PLACED',
      canonical_fill_source: 'PLACEMENT_PROCESS',
    });
    expect(byReq.get('r-legacy')).toMatchObject({
      classification: 'legacy_only',
      legacy_count: 1,
      canonical_count: 0,
      canonical_first_instant: null,
    });
    expect(byReq.get('r-canon')).toMatchObject({
      classification: 'canonical_only',
      legacy_count: 0,
      canonical_count: 1,
      legacy_first_instant: null,
    });
    expect(byReq.get('r-diverge')).toMatchObject({
      classification: 'diverge',
      legacy_count: 2,
      canonical_count: 1,
    });

    // Rule C — evidence only: no verdict/boolean field on any row.
    for (const r of rows) {
      expect(r).not.toHaveProperty('verdict');
      expect(r).not.toHaveProperty('matched');
      expect(typeof r.classification).toBe('string');
    }
    // Deterministic order.
    expect(rows.map((r) => r.requisition_id)).toEqual([
      'r-agree', 'r-canon', 'r-diverge', 'r-legacy',
    ]);
  });

  it('same count but different first instant → diverge (not agree)', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r1' }],
      legacy: [{ requisition_id: 'r1', talent_record_id: 't1', first_placed_at: D('2026-05-05T00:00:00Z') }],
      canonical: [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: D('2026-05-01T00:00:00Z') }],
    });
    const [row] = await svc.getFillShadowCompare(actor);
    expect(row!.classification).toBe('diverge');
    expect(row!.legacy_count).toBe(1);
    expect(row!.canonical_count).toBe(1);
    expect(row!.legacy_first_instant).toBe('2026-05-05T00:00:00.000Z');
    expect(row!.canonical_first_instant).toBe('2026-05-01T00:00:00.000Z');
  });

  it('is diagnostic-only: getFillPerformance never calls the legacy placed read', async () => {
    const { svc, listFirstPlacedByRequisitions } = makeService({
      reqs: [{ id: 'r1' }],
      legacy: [],
      canonical: [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: D('2026-05-01T00:00:00Z') }],
    });
    // The canonical reader touches ONLY readFillCohort — never the legacy placed read.
    await svc.getFillPerformance(actor, { from: D('2026-05-01T00:00:00Z'), to: D('2026-06-01T00:00:00Z') });
    expect(listFirstPlacedByRequisitions).not.toHaveBeenCalled();
  });
});
