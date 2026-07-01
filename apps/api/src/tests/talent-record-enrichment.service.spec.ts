import { describe, expect, it, vi } from 'vitest';
import type { TalentRecordView } from '@aramo/talent-record';

import { TalentRecordEnrichmentService } from '../talent-enrichment/talent-record-enrichment.service.js';

function view(id: string): TalentRecordView {
  return { id } as unknown as TalentRecordView;
}

describe('TalentRecordEnrichmentService', () => {
  it('batches the 3 reads once each and merges; unlinked → do_not_contact', async () => {
    const activity = {
      findLastActivityForTalentIds: vi
        .fn()
        .mockResolvedValue(new Map([['t1', '2026-06-10T00:00:00.000Z']])),
    };
    const pipeline = {
      findCurrentStageForTalentIds: vi
        .fn()
        .mockResolvedValue(
          new Map([['t1', { stage: 'submitted', requisition_id: 'r1' }]]),
        ),
    };
    const consent = {
      findContactingConsentSummaryForTalentIds: vi
        .fn()
        .mockResolvedValue(new Map([['t1', 'contactable']])),
    };
    const svc = new TalentRecordEnrichmentService(
      activity as never,
      consent as never,
      pipeline as never,
      {} as never,
    );

    const out = await svc.enrich([view('t1'), view('t2')], {
      tenant_id: 't',
      visible_requisition_ids: new Set(['r1']),
    });

    expect(out[0]).toMatchObject({
      id: 't1',
      last_activity_at: '2026-06-10T00:00:00.000Z',
      current_stage: { stage: 'submitted', requisition_id: 'r1' },
      consent_summary: 'contactable',
    });
    // unlinked t2 → null activity/stage, do_not_contact
    expect(out[1]).toMatchObject({
      id: 't2',
      last_activity_at: null,
      current_stage: null,
      consent_summary: 'do_not_contact',
    });

    // BATCH, never loop — one call each.
    expect(activity.findLastActivityForTalentIds).toHaveBeenCalledTimes(1);
    expect(pipeline.findCurrentStageForTalentIds).toHaveBeenCalledTimes(1);
    expect(consent.findContactingConsentSummaryForTalentIds).toHaveBeenCalledTimes(1);
    // Step-5 consent re-key: consent queried by TalentRecord.id (the page's id
    // set); pipeline got the visible set.
    expect(
      consent.findContactingConsentSummaryForTalentIds.mock.calls[0]![0].talent_record_ids,
    ).toEqual(['t1', 't2']);
    expect([
      ...pipeline.findCurrentStageForTalentIds.mock.calls[0]![0]
        .visible_requisition_ids,
    ]).toEqual(['r1']);
  });

  it('queries consent by TalentRecord.id; no contacting grant → do_not_contact', async () => {
    const consent = {
      findContactingConsentSummaryForTalentIds: vi.fn().mockResolvedValue(new Map()),
    };
    const svc = new TalentRecordEnrichmentService(
      { findLastActivityForTalentIds: vi.fn().mockResolvedValue(new Map()) } as never,
      consent as never,
      { findCurrentStageForTalentIds: vi.fn().mockResolvedValue(new Map()) } as never,
      {} as never,
    );
    const out = await svc.enrich([view('t1')], {
      tenant_id: 't',
      visible_requisition_ids: null,
    });
    // Step-5 consent re-key: consent is keyed by TalentRecord.id, so the query
    // always runs over the page's id set (no Core-link gating).
    expect(consent.findContactingConsentSummaryForTalentIds).toHaveBeenCalledTimes(1);
    expect(
      consent.findContactingConsentSummaryForTalentIds.mock.calls[0]![0].talent_record_ids,
    ).toEqual(['t1']);
    expect(out[0]!.consent_summary).toBe('do_not_contact');
  });

  it('returns [] for empty input without querying', async () => {
    const activity = { findLastActivityForTalentIds: vi.fn() };
    const svc = new TalentRecordEnrichmentService(
      activity as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(
      await svc.enrich([], { tenant_id: 't', visible_requisition_ids: null }),
    ).toEqual([]);
    expect(activity.findLastActivityForTalentIds).not.toHaveBeenCalled();
  });
});

const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

describe('TalentRecordEnrichmentService.crossFacets (Segment 4b)', () => {
  it('aggregates FULL-SET recency / consent / stage counts over the matched keys', async () => {
    const activity = {
      findLastActivityForTalentIds: vi.fn().mockResolvedValue(
        new Map([
          ['t1', isoDaysAgo(0)], // today
          ['t2', isoDaysAgo(5)], // within 7d
          ['t3', isoDaysAgo(100)], // stale (>=90d)
          // t4 absent → no activity → stale
        ]),
      ),
    };
    const pipeline = {
      findCurrentStageForTalentIds: vi.fn().mockResolvedValue(
        new Map([
          ['t1', { stage: 'submitted', requisition_id: 'r1' }],
          ['t2', { stage: 'screening', requisition_id: 'r2' }],
          // t3, t4 absent → 'none'
        ]),
      ),
    };
    const consent = {
      findContactingConsentSummaryForTalentIds: vi.fn().mockResolvedValue(
        new Map([
          ['t1', 'contactable'],
          ['t2', 'expiring_lt_30d'],
          // t3 + t4 absent → do_not_contact (no positive grant)
        ]),
      ),
    };
    const talent = {
      findFilteredKeys: vi.fn().mockResolvedValue([
        { id: 't1' },
        { id: 't2' },
        { id: 't3' }, // no positive grant → do_not_contact
        { id: 't4' },
      ]),
    };
    const svc = new TalentRecordEnrichmentService(
      activity as never,
      consent as never,
      pipeline as never,
      talent as never,
    );

    const query = { tenant_id: 't', sort: 'name' as const };
    const out = await svc.crossFacets(query as never, {
      tenant_id: 't',
      visible_requisition_ids: new Set(['r1', 'r2']),
    });

    expect(out.over_guard).toBe(false);
    expect(out.matched).toBe(4);
    expect(out.guard).toBe(5000);
    // cumulative recency tiers: today ⊆ 7d ⊆ 30d; stale separate.
    expect(out.recency).toEqual({ today: 1, '7d': 2, '30d': 2, stale: 2 });
    // consent — unlinked + missing grant both fold to do_not_contact.
    expect(new Map(out.consent.map((b) => [b.value, b.count]))).toEqual(
      new Map([
        ['contactable', 1],
        ['expiring_lt_30d', 1],
        ['do_not_contact', 2],
      ]),
    );
    expect(new Map(out.stage.map((b) => [b.value, b.count]))).toEqual(
      new Map([
        ['submitted', 1],
        ['screening', 1],
        ['none', 2],
      ]),
    );
    // findFilteredKeys was given the guard as its limit; the cross reads ran
    // over the resolved id set only (resolve-then-filter; no cross-schema join).
    expect(talent.findFilteredKeys).toHaveBeenCalledWith(query, 5000);
    expect(activity.findLastActivityForTalentIds).toHaveBeenCalledTimes(1);
  });

  it('returns over_guard and SKIPS the cross-schema reads beyond the threshold', async () => {
    const prev = process.env['TALENT_XFACET_GUARD'];
    process.env['TALENT_XFACET_GUARD'] = '2';
    try {
      const activity = { findLastActivityForTalentIds: vi.fn() };
      const pipeline = { findCurrentStageForTalentIds: vi.fn() };
      const consent = { findContactingConsentSummaryForTalentIds: vi.fn() };
      // guard=2 → findFilteredKeys returns up to guard+1=3; 3 > 2 ⇒ over.
      const talent = {
        findFilteredKeys: vi
          .fn()
          .mockResolvedValue([{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
      };
      const svc = new TalentRecordEnrichmentService(
        activity as never,
        consent as never,
        pipeline as never,
        talent as never,
      );

      const out = await svc.crossFacets({ tenant_id: 't' } as never, {
        tenant_id: 't',
        visible_requisition_ids: null,
      });

      expect(out).toEqual({
        over_guard: true,
        matched: 3, // guard + 1 sentinel
        guard: 2,
        recency: { today: 0, '7d': 0, '30d': 0, stale: 0 },
        consent: [],
        stage: [],
      });
      // no silent perf cliff: the cross-schema reads never ran.
      expect(activity.findLastActivityForTalentIds).not.toHaveBeenCalled();
      expect(pipeline.findCurrentStageForTalentIds).not.toHaveBeenCalled();
      expect(consent.findContactingConsentSummaryForTalentIds).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env['TALENT_XFACET_GUARD'];
      else process.env['TALENT_XFACET_GUARD'] = prev;
    }
  });
});
