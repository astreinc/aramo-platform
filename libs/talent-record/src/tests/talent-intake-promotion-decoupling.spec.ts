import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { type AuthContextType } from '@aramo/auth';

import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';

// ADR-0033 local-gap PO ruling — résumé extraction is ASYNC ENRICHMENT, never an
// admission prerequisite. A recruiter may promote/create a Talent whenever the
// Talent admission invariant (first_name, last_name, email1, phone_cell) is
// satisfied, REGARDLESS of extraction state (QUEUED / PROCESSING / PARTIAL /
// FAILED / child-absent). The only blockers are admission/auth/dedup/concurrency
// — never "the LLM / EventBridge / SQS is slow or unavailable".
//
// RED-first proof of the decoupling: before the fix, promote() throws the
// "This résumé is still being read" 422 whenever resume_extraction_draft_id is
// null; after, a childless intake with valid admission fields CREATES the Talent
// via the decoupled createFromReviewedUpload path, and the résumé stays attached.

const AUTH = { tenant_id: 'tenant-1', sub: 'actor-1' } as unknown as AuthContextType;

function reviewPayload(fields: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, origin: 'RECRUITER' }]),
    ),
    work_history: [],
    education: [],
    certifications: [],
  };
}

function intakeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'intake-1',
    tenant_id: 'tenant-1',
    source_type: 'RESUME_UPLOAD',
    source_filename: 'Uma_Maheshwari.pdf',
    storage_key: 'tenant-1/talent/intake-1/resume/obj-Uma.pdf',
    artifact_sha256: 'sha-abc',
    mime_type: 'application/pdf',
    size_bytes: 48000,
    processing_status: 'QUEUED',
    review_status: 'IN_REVIEW',
    resume_extraction_draft_id: null,
    promoted_talent_record_id: null,
    review_payload: reviewPayload({
      first_name: 'Uma',
      last_name: 'Maheshwari',
      email1: 'umasivasamy@yahoo.com',
      phone_cell: '571-435-5777',
      city: 'Centerville',
      state: 'VA',
    }),
    ...over,
  };
}

function makeService(over: {
  intake?: Record<string, unknown> | null;
  createdFromReviewed?: unknown;
  createdFromDraft?: unknown;
}) {
  const talentExtraction = {
    findTalentIntakeDraftById: vi.fn().mockResolvedValue(over.intake === undefined ? intakeRow() : over.intake),
    markTalentIntakeDraftPromoted: vi.fn().mockResolvedValue(1),
  };
  const createFromDraft = {
    confirmCreateFromDraftUpload: vi.fn().mockResolvedValue(over.createdFromDraft ?? null),
    createFromReviewedUpload: vi.fn().mockResolvedValue(over.createdFromReviewed ?? { id: 'talent-1' }),
  };
  const repo = {
    findById: vi.fn().mockResolvedValue(null),
  };
  const svc = new TalentIntakePromotionService(
    talentExtraction as never,
    createFromDraft as never,
    repo as never,
  );
  return { svc, talentExtraction, createFromDraft, repo };
}

describe('TalentIntakePromotionService — extraction-decoupled promotion (ADR-0033 local-gap)', () => {
  it('childless intake (resume_extraction_draft_id=null) with valid admission fields CREATES the Talent via the decoupled path — no 422', async () => {
    const { svc, createFromDraft, talentExtraction } = makeService({
      intake: intakeRow({ resume_extraction_draft_id: null }),
      createdFromReviewed: { id: 'talent-1' },
    });

    const result = await svc.promote(AUTH, 'intake-1', 'req-1');

    expect(result).toEqual({ id: 'talent-1' });
    // Decoupled create used; the enrichment (draft) path is NOT taken (no child).
    expect(createFromDraft.createFromReviewedUpload).toHaveBeenCalledTimes(1);
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled();
    // Promotion linkage is recorded against the created Talent.
    expect(talentExtraction.markTalentIntakeDraftPromoted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'intake-1', promoted_talent_record_id: 'talent-1' }),
    );
  });

  it('résumé stays attached: the decoupled create receives the intake storage_key in resume_document', async () => {
    const { svc, createFromDraft } = makeService({ intake: intakeRow({ resume_extraction_draft_id: null }) });

    await svc.promote(AUTH, 'intake-1', 'req-1');

    const body = createFromDraft.createFromReviewedUpload.mock.calls[0][1] as {
      resume_document?: { storage_key?: string };
    };
    expect(body.resume_document?.storage_key).toBe('tenant-1/talent/intake-1/resume/obj-Uma.pdf');
  });

  it('missing admission field (phone_cell) still 422s field-keyed — NOT the "still being read" message', async () => {
    const { svc } = makeService({
      intake: intakeRow({
        resume_extraction_draft_id: null,
        review_payload: reviewPayload({ first_name: 'Uma', last_name: 'M', email1: 'u@x.com' }),
      }),
    });

    await expect(svc.promote(AUTH, 'intake-1', 'req-1')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { missing: expect.arrayContaining(['phone_cell']) } },
    });
  });

  it('enrichment path PRESERVED: a READY extraction child promotes through confirmCreateFromDraftUpload', async () => {
    const { svc, createFromDraft } = makeService({
      intake: intakeRow({ resume_extraction_draft_id: 'child-1' }),
      createdFromDraft: { id: 'talent-enriched' },
    });

    const result = await svc.promote(AUTH, 'intake-1', 'req-1');

    expect(result).toEqual({ id: 'talent-enriched' });
    expect(createFromDraft.confirmCreateFromDraftUpload).toHaveBeenCalledTimes(1);
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
  });

  it('child present but NOT ready (confirm returns null) FALLS THROUGH to the decoupled create — still creates', async () => {
    const { svc, createFromDraft } = makeService({
      intake: intakeRow({ resume_extraction_draft_id: 'child-1', processing_status: 'PROCESSING' }),
      createdFromDraft: null,
      createdFromReviewed: { id: 'talent-fallthrough' },
    });

    const result = await svc.promote(AUTH, 'intake-1', 'req-1');

    expect(result).toEqual({ id: 'talent-fallthrough' });
    expect(createFromDraft.confirmCreateFromDraftUpload).toHaveBeenCalledTimes(1);
    expect(createFromDraft.createFromReviewedUpload).toHaveBeenCalledTimes(1);
  });

  it('idempotent: an already-promoted intake returns the existing TalentRecord without re-creating', async () => {
    const { svc, createFromDraft, repo } = makeService({
      intake: intakeRow({ promoted_talent_record_id: 'talent-existing' }),
    });
    repo.findById.mockResolvedValue({ id: 'talent-existing' });

    const result = await svc.promote(AUTH, 'intake-1', 'req-1');

    expect(result).toEqual({ id: 'talent-existing' });
    expect(createFromDraft.createFromReviewedUpload).not.toHaveBeenCalled();
    expect(createFromDraft.confirmCreateFromDraftUpload).not.toHaveBeenCalled();
  });

  it('not found → 404', async () => {
    const { svc } = makeService({ intake: null });
    await expect(svc.promote(AUTH, 'missing', 'req-1')).rejects.toBeInstanceOf(AramoError);
  });
});
