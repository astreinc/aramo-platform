import { describe, expect, it, vi } from 'vitest';
import type { TalentRecordView } from '@aramo/talent-record';

import { TalentRecordEnrichmentService } from '../talent-enrichment/talent-record-enrichment.service.js';

function view(id: string, core: string | null = null): TalentRecordView {
  return { id, core_talent_id: core } as unknown as TalentRecordView;
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
        .mockResolvedValue(new Map([['core1', 'contactable']])),
    };
    const svc = new TalentRecordEnrichmentService(
      activity as never,
      consent as never,
      pipeline as never,
    );

    const out = await svc.enrich([view('t1', 'core1'), view('t2')], {
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
    // consent only queried for the linked core id; pipeline got the visible set.
    expect(
      consent.findContactingConsentSummaryForTalentIds.mock.calls[0]![0].talent_ids,
    ).toEqual(['core1']);
    expect([
      ...pipeline.findCurrentStageForTalentIds.mock.calls[0]![0]
        .visible_requisition_ids,
    ]).toEqual(['r1']);
  });

  it('skips the consent query when no item is Core-linked', async () => {
    const consent = { findContactingConsentSummaryForTalentIds: vi.fn() };
    const svc = new TalentRecordEnrichmentService(
      { findLastActivityForTalentIds: vi.fn().mockResolvedValue(new Map()) } as never,
      consent as never,
      { findCurrentStageForTalentIds: vi.fn().mockResolvedValue(new Map()) } as never,
    );
    const out = await svc.enrich([view('t1')], {
      tenant_id: 't',
      visible_requisition_ids: null,
    });
    expect(consent.findContactingConsentSummaryForTalentIds).not.toHaveBeenCalled();
    expect(out[0]!.consent_summary).toBe('do_not_contact');
  });

  it('returns [] for empty input without querying', async () => {
    const activity = { findLastActivityForTalentIds: vi.fn() };
    const svc = new TalentRecordEnrichmentService(
      activity as never,
      {} as never,
      {} as never,
    );
    expect(
      await svc.enrich([], { tenant_id: 't', visible_requisition_ids: null }),
    ).toEqual([]);
    expect(activity.findLastActivityForTalentIds).not.toHaveBeenCalled();
  });
});
