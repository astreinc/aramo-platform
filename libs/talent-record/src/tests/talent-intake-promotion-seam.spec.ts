import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';

// Talent Draft Recovery §13 — the authority seam: a FAILED / no-child draft must
// still create a Talent once the canonical admission fields are satisfied.
// resume_extraction_draft_id must NOT be an accidental creation prerequisite.
// Pure unit (fakes) proving the branch selection + that extraction state never
// gates creation.

const AUTH = { tenant_id: 'T', sub: 'A' } as unknown as AuthContextType;

function reviewWith(fields: Record<string, string>): unknown {
  return {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, origin: 'RECRUITER' }]),
    ),
  };
}

const ADMISSIBLE = reviewWith({
  first_name: 'Uma',
  last_name: 'Maheshwari',
  email1: 'uma@example.com',
  phone_cell: '555-0100',
});

function makeIntake(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    tenant_id: 'T',
    created_by: 'A',
    storage_key: 'k',
    source_filename: 'r.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1,
    resume_extraction_draft_id: null,
    processing_status: 'FAILED',
    review_status: 'IN_REVIEW',
    promoted_talent_record_id: null,
    review_payload: ADMISSIBLE,
    ...over,
  };
}

function build(over: {
  intake?: Record<string, unknown> | null;
  confirm?: unknown;
  manual?: unknown;
  markPromoted?: number;
  findById?: unknown;
}) {
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(async () => over.intake === undefined ? makeIntake() : over.intake),
    markTalentIntakeDraftPromoted: vi.fn(async () => over.markPromoted ?? 1),
  };
  const createFromDraft = {
    confirmCreateFromDraftUpload: vi.fn(async () => over.confirm ?? null),
    createManualFromReview: vi.fn(async () => over.manual ?? { id: 'manual-rec' }),
  };
  const repo = {
    findById: vi.fn(async () => over.findById ?? null),
  };
  const svc = new TalentIntakePromotionService(
    talentExtraction as never,
    createFromDraft as never,
    repo as never,
  );
  return { svc, talentExtraction, createFromDraft, repo };
}

describe('TalentIntakePromotionService — §13 creation authority seam', () => {
  it('FAILED + no child + admissible → manual create (NOT a 422), never requires a child', async () => {
    const { svc, createFromDraft, talentExtraction } = build({
      intake: makeIntake({ resume_extraction_draft_id: null, processing_status: 'FAILED' }),
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'manual-rec' });
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled(); // no child → never the governed path
    expect(createFromDraft.createManualFromReview).toHaveBeenCalledOnce();
    // The promotion-linkage CAS is the convergence anchor (reserved id claimed).
    expect(talentExtraction.markTalentIntakeDraftPromoted).toHaveBeenCalledOnce();
  });

  it('still-reading (PROCESSING) + no child + admissible → manual create, not blocked (§12)', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ resume_extraction_draft_id: null, processing_status: 'PROCESSING' }),
    });
    await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(createFromDraft.createManualFromReview).toHaveBeenCalledOnce();
  });

  it('child exists but not confirmable (returns null) → falls through to manual create, no 422', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ resume_extraction_draft_id: 'child-1', processing_status: 'FAILED' }),
      confirm: null,
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(createFromDraft.confirmCreateFromDraftUpload).toHaveBeenCalledOnce();
    expect(createFromDraft.createManualFromReview).toHaveBeenCalledOnce();
    expect(res).toEqual({ id: 'manual-rec' });
  });

  it('confirmable child → governed path, manual create NOT used', async () => {
    const { svc, createFromDraft, talentExtraction } = build({
      intake: makeIntake({ resume_extraction_draft_id: 'child-1', processing_status: 'READY' }),
      confirm: { id: 'governed-rec' },
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'governed-rec' });
    expect(createFromDraft.createManualFromReview).not.toHaveBeenCalled();
    expect(talentExtraction.markTalentIntakeDraftPromoted).toHaveBeenCalledWith(
      expect.objectContaining({ promoted_talent_record_id: 'governed-rec' }),
    );
  });

  it('missing admission fields → 422, regardless of extraction state', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ review_payload: reviewWith({ first_name: 'Uma' }) }),
    });
    await expect(svc.promote(AUTH, 'draft-1', 'req-1')).rejects.toMatchObject({
      name: 'AramoError',
      statusCode: 422,
    });
    expect(createFromDraft.createManualFromReview).not.toHaveBeenCalled();
  });

  it('already promoted → returns existing, creates nothing', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ promoted_talent_record_id: 'existing-rec' }),
      findById: { id: 'existing-rec' },
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'existing-rec' });
    expect(createFromDraft.createManualFromReview).not.toHaveBeenCalled();
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled();
  });
});
