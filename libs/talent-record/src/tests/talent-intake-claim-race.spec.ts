import { describe, expect, it, vi } from 'vitest';

import { TalentIntakeExtractionService } from '../lib/talent-intake/talent-intake-extraction.service.js';

// ATI-SEP-1 A4 — the worker claim race. The claim CASes on the version the
// worker just read; a recruiter review save landing between that read and the
// claim bumps the version without claiming. Before the fix the single attempt
// lost and the draft stayed QUEUED forever; now a lost CAS re-reads and
// re-claims on the newer version while the draft is still QUEUED.

function row(version: number, over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    tenant_id: 't-1',
    created_by: 'a-1',
    processing_status: 'QUEUED',
    promoted_talent_record_id: null,
    storage_key: null,
    structured_payload: null,
    version,
    ...over,
  };
}

function make(reads: unknown[], claims: number[]) {
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(),
    claimTalentIntakeDraftForProcessing: vi.fn(),
    markTalentIntakeDraftProcessed: vi.fn().mockResolvedValue(undefined),
  };
  for (const r of reads) talentExtraction.findTalentIntakeDraftById.mockResolvedValueOnce(r);
  for (const c of claims) talentExtraction.claimTalentIntakeDraftForProcessing.mockResolvedValueOnce(c);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const svc = new TalentIntakeExtractionService({} as never, talentExtraction as never, logger as never);
  return { svc, talentExtraction };
}

describe('ATI-SEP-1 A4 — intake worker claim race', () => {
  it('a review save between read and claim (version moved, still QUEUED) → re-reads and claims on the new version', async () => {
    const m = make([row(3), row(4)], [0, 1]);
    const ran = await m.svc.processIntakeDraft({ draft_id: 'd-1', tenant_id: 't-1' });
    expect(ran).toBe(true);
    expect(m.talentExtraction.claimTalentIntakeDraftForProcessing).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expected_version: 4 }),
    );
    // Non-artifact draft → processed to a terminal state (no longer QUEUED).
    expect(m.talentExtraction.markTalentIntakeDraftProcessed).toHaveBeenCalledOnce();
  });

  it('a concurrent worker claimed it (re-read shows PROCESSING) → idempotent no-op, no re-claim', async () => {
    const m = make([row(3), row(4, { processing_status: 'PROCESSING' })], [0]);
    const ran = await m.svc.processIntakeDraft({ draft_id: 'd-1', tenant_id: 't-1' });
    expect(ran).toBe(false);
    expect(m.talentExtraction.claimTalentIntakeDraftForProcessing).toHaveBeenCalledOnce();
    expect(m.talentExtraction.markTalentIntakeDraftProcessed).not.toHaveBeenCalled();
  });

  it('bounded: persistent contention yields after 3 attempts (left for the next delivery)', async () => {
    const m = make([row(1), row(2), row(3)], [0, 0, 0]);
    const ran = await m.svc.processIntakeDraft({ draft_id: 'd-1', tenant_id: 't-1' });
    expect(ran).toBe(false);
    expect(m.talentExtraction.claimTalentIntakeDraftForProcessing).toHaveBeenCalledTimes(3);
  });

  it('a promoted draft is never claimed', async () => {
    const m = make([row(1, { promoted_talent_record_id: 'tal-1' })], []);
    expect(await m.svc.processIntakeDraft({ draft_id: 'd-1', tenant_id: 't-1' })).toBe(false);
    expect(m.talentExtraction.claimTalentIntakeDraftForProcessing).not.toHaveBeenCalled();
  });
});
