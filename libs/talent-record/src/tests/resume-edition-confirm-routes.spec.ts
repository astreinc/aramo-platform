import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { ResumeExtractionDraftNotReviewableError } from '@aramo/talent-extraction';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1F-B — the review CONFIRM / REJECT routes on an existing
// Talent's résumé edition. CONFIRM promotes the reviewed draft's accepted facts
// to typed evidence (delegated to the atomic service promotion); REJECT writes no
// evidence. Both guard: talent+edition in tenant, a draft that is READY_FOR_REVIEW.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const EDITION = 'ed-1';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:edit'] } as unknown as AuthContextType;

function editionRow(over: Record<string, unknown> = {}) {
  return {
    id: EDITION,
    tenant_id: TENANT,
    talent_id: TALENT,
    talent_document_id: 'doc-1',
    attachment_id: 'att-1',
    content_hash: 'h',
    purpose: 'GENERAL',
    label: null,
    requisition_id: null,
    client_context_id: null,
    derived_from_edition_id: null,
    lifecycle_status: 'active',
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    created_by: 'me',
    document_filename: 'resume.pdf',
    document_mime_type: 'application/pdf',
    document_uploaded_at: new Date('2026-07-01T00:00:00.000Z'),
    is_default: true,
    processing_status: 'ACCEPTED',
    ...over,
  };
}

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'dr-1',
    tenant_id: TENANT,
    source_kind: 'ATTACHMENT',
    source_ref: 'att-1',
    talent_id: TALENT,
    talent_document_id: 'doc-1',
    resume_edition_id: EDITION,
    status: 'READY_FOR_REVIEW',
    ...over,
  };
}

function make(parts: {
  talent?: unknown;
  edition?: unknown;
  draft?: unknown;
  promoteThrows?: Error;
  rejectedCount?: number;
} = {}) {
  const findById = vi.fn().mockResolvedValue(parts.talent === undefined ? { id: TALENT } : parts.talent);
  const repo = { findById };
  const findResumeEditionById = vi
    .fn()
    .mockResolvedValue(parts.edition === undefined ? { id: EDITION, tenant_id: TENANT, talent_id: TALENT } : parts.edition);
  const findResumeExtractionDraftByEdition = vi
    .fn()
    .mockResolvedValue(parts.draft === undefined ? draftRow() : parts.draft);
  const promoteResumeExtractionDraft = parts.promoteThrows
    ? vi.fn().mockRejectedValue(parts.promoteThrows)
    : vi.fn().mockResolvedValue({
        work_history_ids: ['wh-1'],
        skill_evidence_ids: ['sk-1'],
        project_ids: [],
        education_ids: [],
        certification_ids: [],
      });
  const markResumeExtractionDraftRejected = vi.fn().mockResolvedValue(parts.rejectedCount ?? 1);
  const listResumeEditionsWithDocument = vi.fn().mockResolvedValue([editionRow()]);
  const talentExtraction = {
    findResumeEditionById,
    findResumeExtractionDraftByEdition,
    promoteResumeExtractionDraft,
    markResumeExtractionDraftRejected,
    listResumeEditionsWithDocument,
  };
  const ctl = new TalentRecordController(
    repo as never, {} as never, {} as never, {} as never,
    talentExtraction as never, {} as never, {} as never,
    undefined, {} as never, {} as never, {} as never,
  );
  return { ctl, findById, findResumeEditionById, findResumeExtractionDraftByEdition, promoteResumeExtractionDraft, markResumeExtractionDraftRejected };
}

describe('TI-1F-B — POST :id/resume-editions/:editionId/confirm', () => {
  it('promotes the reviewed draft and returns the edition view (processing_status ACCEPTED)', async () => {
    const { ctl, promoteResumeExtractionDraft } = make();
    const res = await ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1');
    expect(promoteResumeExtractionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ id: 'dr-1' }), actor_id: 'me' }),
    );
    expect(res.edition_id).toBe(EDITION);
    expect(res.processing_status).toBe('ACCEPTED');
  });

  it('404 when the talent is not in the tenant', async () => {
    const { ctl, promoteResumeExtractionDraft } = make({ talent: null });
    await expect(ctl.confirmResumeEdition(AUTH, 'missing', EDITION, 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
  });

  it('404 when the edition does not belong to this talent', async () => {
    const { ctl, promoteResumeExtractionDraft } = make({ edition: { id: EDITION, tenant_id: TENANT, talent_id: 'other' } });
    await expect(ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
  });

  it('404 when there is no draft under review for the edition', async () => {
    const { ctl, promoteResumeExtractionDraft } = make({ draft: null });
    await expect(ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
  });

  it('409 when the draft is not READY_FOR_REVIEW (still PROCESSING) — no promotion', async () => {
    const { ctl, promoteResumeExtractionDraft } = make({ draft: draftRow({ status: 'PROCESSING' }) });
    await expect(ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESUME_EXTRACTION_DRAFT_ALREADY_REVIEWED',
    });
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
  });

  it('422 when the draft has no talent/document anchor — no promotion', async () => {
    const { ctl, promoteResumeExtractionDraft } = make({ draft: draftRow({ talent_document_id: null }) });
    await expect(ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({ statusCode: 422 });
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
  });

  it('409 when the promotion loses the READY_FOR_REVIEW race (tx rolled back)', async () => {
    const { ctl } = make({ promoteThrows: new ResumeExtractionDraftNotReviewableError('dr-1') });
    await expect(ctl.confirmResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESUME_EXTRACTION_DRAFT_ALREADY_REVIEWED',
    });
  });
});

describe('TI-1F-B — POST :id/resume-editions/:editionId/reject', () => {
  it('marks the draft REJECTED, authors NO evidence, and returns the edition view', async () => {
    const { ctl, markResumeExtractionDraftRejected, promoteResumeExtractionDraft } = make({
      edition: { id: EDITION, tenant_id: TENANT, talent_id: TALENT },
    });
    const res = await ctl.rejectResumeEdition(AUTH, TALENT, EDITION, 'rq-1');
    expect(markResumeExtractionDraftRejected).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dr-1', tenant_id: TENANT, reviewed_by: 'me' }),
    );
    // REJECT never promotes evidence (§3).
    expect(promoteResumeExtractionDraft).not.toHaveBeenCalled();
    expect(res.edition_id).toBe(EDITION);
  });

  it('409 when the draft is no longer reviewable at reject time (race → 0 rows)', async () => {
    const { ctl } = make({ rejectedCount: 0 });
    await expect(ctl.rejectResumeEdition(AUTH, TALENT, EDITION, 'rq-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESUME_EXTRACTION_DRAFT_ALREADY_REVIEWED',
    });
  });
});
