import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';

// Talent Draft Recovery §13 + PO/Lead forward-merge ruling — the promotion seam:
//  (a) extraction is NEVER a creation prerequisite — a FAILED / still-reading /
//      no-child draft creates once the canonical admission fields are present,
//      via main's canonical createFromReviewedUpload (NOT a second path);
//  (b) exactly-once / replay-safe convergence — the guarded promotion-linkage CAS
//      elects a single winner (claim-first reserved id) and the create is
//      idempotent on it, so a lost claim returns the winner's record (no double
//      create);
//  (c) the hard active-email duplicate 409 is enforced before any linkage claim.
// Pure unit (fakes); the DB-level enforcement is proven by the integration specs.

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
  reviewed?: unknown;
  markPromoted?: number;
  findById?: unknown;
  activeByEmail?: unknown;
}) {
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn(async () => (over.intake === undefined ? makeIntake() : over.intake)),
    markTalentIntakeDraftPromoted: vi.fn(async () => over.markPromoted ?? 1),
  };
  const createFromDraft = {
    confirmCreateFromDraftUpload: vi.fn(async () => over.confirm ?? null),
    createFromReviewedUpload: vi.fn(async () => over.reviewed ?? { id: 'reviewed-rec' }),
  };
  const repo = {
    findById: vi.fn(async () => over.findById ?? null),
    findActiveByEmail: vi.fn(async () => over.activeByEmail ?? null),
  };
  const svc = new TalentIntakePromotionService(
    talentExtraction as never,
    createFromDraft as never,
    repo as never,
  );
  return { svc, talentExtraction, createFromDraft, repo };
}

describe('TalentIntakePromotionService — §13 authority seam + convergence', () => {
  it('FAILED + no child + admissible → decoupled createFromReviewedUpload (NOT 422, never a child requirement)', async () => {
    const { svc, createFromDraft, talentExtraction } = build({
      intake: makeIntake({ resume_extraction_draft_id: null, processing_status: 'FAILED' }),
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'reviewed-rec' });
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled();
    expect(createFromDraft.createFromReviewedUpload).toHaveBeenCalledOnce();
    // Claim-first: the promotion-linkage CAS is claimed with a reserved id BEFORE
    // the create, and that same id is passed to the idempotent create.
    expect(talentExtraction.markTalentIntakeDraftPromoted).toHaveBeenCalledOnce();
    const reservedId = talentExtraction.markTalentIntakeDraftPromoted.mock.calls[0][0].promoted_talent_record_id;
    const passedId = createFromDraft.createFromReviewedUpload.mock.calls[0][4];
    expect(passedId).toBe(reservedId);
  });

  it('still-reading (PROCESSING) + no child + admissible → decoupled create, not blocked (§12)', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ resume_extraction_draft_id: null, processing_status: 'PROCESSING' }),
    });
    await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(createFromDraft.createFromReviewedUpload).toHaveBeenCalledOnce();
  });

  it('child exists but not confirmable (confirm → null) → falls through to decoupled create, no 422', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ resume_extraction_draft_id: 'child-1', processing_status: 'FAILED' }),
      confirm: null,
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(createFromDraft.confirmCreateFromDraftUpload).toHaveBeenCalledOnce();
    expect(createFromDraft.createFromReviewedUpload).toHaveBeenCalledOnce();
    expect(res).toEqual({ id: 'reviewed-rec' });
  });

  it('confirmable child → governed path; decoupled create NOT used; linkage on the governed id', async () => {
    const { svc, createFromDraft, talentExtraction } = build({
      intake: makeIntake({ resume_extraction_draft_id: 'child-1', processing_status: 'READY' }),
      confirm: { id: 'governed-rec' },
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'governed-rec' });
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
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
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
  });

  it('already promoted → returns existing, creates nothing (replay-safe)', async () => {
    const { svc, createFromDraft } = build({
      intake: makeIntake({ promoted_talent_record_id: 'existing-rec' }),
      findById: { id: 'existing-rec' },
    });
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'existing-rec' });
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled();
  });

  it('CONCURRENCY — lost the linkage claim (CAS count 0) → returns the winner record, does NOT create', async () => {
    const { svc, createFromDraft, repo } = build({
      intake: makeIntake({ resume_extraction_draft_id: null }),
      markPromoted: 0, // we lost the claim
      // On re-read the winner has linked its record; repo resolves it.
      findById: { id: 'winner-rec' },
    });
    // Re-read after the lost claim returns the winner's linkage.
    const res = await svc.promote(AUTH, 'draft-1', 'req-1');
    expect(res).toEqual({ id: 'winner-rec' });
    expect(repo.findById).toHaveBeenCalled();
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled(); // no double create
  });

  it('hard active-email duplicate (different record) → 409 BEFORE any linkage claim', async () => {
    const { svc, createFromDraft, talentExtraction } = build({
      intake: makeIntake({ resume_extraction_draft_id: null }),
      activeByEmail: { id: 'other-rec' },
    });
    await expect(svc.promote(AUTH, 'draft-1', 'req-1')).rejects.toMatchObject({
      name: 'AramoError',
      statusCode: 409,
    });
    // No stuck PROMOTED-but-recordless draft: the claim never happened.
    expect(talentExtraction.markTalentIntakeDraftPromoted).not.toHaveBeenCalled();
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
  });
});
