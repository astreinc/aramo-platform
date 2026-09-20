import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import { ResumeExtractionDraftNotReviewableError } from '@aramo/talent-extraction';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1F-C (strengthened-D) — the ordered, idempotent, recoverable
// CREATE_DRAFT_UPLOAD promotion. Invariant: a genuine TalentRecord never exists
// unless its accepted résumé evidence lifecycle is already durable. These prove the
// Gate matrix: evidence-first / Talent-last ordering; ACCEPTED only after Talent;
// every failure recoverable with no duplicate Talent / evidence / second model call.

const TENANT = '11111111-1111-7111-8111-111111111111';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:create'] } as unknown as AuthContextType;

function body(over: Record<string, unknown> = {}) {
  return {
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    phone_cell: '555-0100',
    draft_id: 'draft-1',
    resume_document: {
      storage_key: 's3/resume.pdf',
      file_name: 'resume.pdf',
      mime_type: 'application/pdf',
      size_bytes: 42,
      source_map_version: 'resume-source-map/v1',
      resume_text_hash: 'hash-9',
    },
    work_history: [{ employer_name: 'Northstar', role_title: 'Cloud Engineer', source_refs: ['B004'] }],
    skills: [{ surface_form: 'C#', source_refs: ['B003'] }],
    ...over,
  };
}

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    tenant_id: TENANT,
    source_kind: 'CREATE_DRAFT_UPLOAD',
    status: 'READY_FOR_REVIEW',
    talent_id: null,
    talent_document_id: null,
    resume_edition_id: null,
    ...over,
  };
}

function make(parts: {
  draft?: unknown;
  duplicate?: unknown;
  existingTalent?: unknown; // findById result
  establishThrows?: Error;
  createThrows?: Error;
} = {}) {
  const findActiveByEmail = vi.fn().mockResolvedValue(parts.duplicate ?? null);
  const findById = vi.fn().mockResolvedValue(parts.existingTalent ?? null);
  const create = parts.createThrows
    ? vi.fn().mockRejectedValue(parts.createThrows)
    : vi.fn().mockImplementation(async (args: { id?: string }) => ({ id: args.id ?? 'tal-generated', first_name: 'Ada', last_name: 'Lovelace' }));
  const repo = { findActiveByEmail, findById, create };

  const findResumeExtractionDraftById = vi
    .fn()
    .mockResolvedValue(parts.draft === undefined ? draftRow() : parts.draft);
  const establishCreateDraftEvidence = parts.establishThrows
    ? vi.fn().mockRejectedValue(parts.establishThrows)
    : vi.fn().mockResolvedValue({ document_id: 'doc-new', edition_id: 'ed-new' });
  const markResumeExtractionDraftAccepted = vi.fn().mockResolvedValue(1);
  // NO model surface on this mock — a promotion must never re-extract.
  const talentExtraction = {
    findResumeExtractionDraftById,
    establishCreateDraftEvidence,
    markResumeExtractionDraftAccepted,
  };
  const enqueueCanonical = vi.fn().mockResolvedValue(undefined);
  const enqueueTalentReconcile = vi.fn().mockResolvedValue(undefined);

  const ctl = new TalentRecordController(
    repo as never, {} as never, {} as never, {} as never,
    talentExtraction as never, {} as never, {} as never,
    { enqueueTalent: enqueueCanonical } as never, {} as never, {} as never, {} as never,
    { enqueueTalent: enqueueTalentReconcile } as never,
  );
  return { ctl, findActiveByEmail, findById, create, findResumeExtractionDraftById, establishCreateDraftEvidence, markResumeExtractionDraftAccepted, enqueueCanonical, enqueueTalentReconcile };
}

describe('TI-1F-C strengthened-D — confirmCreateFromDraftUpload ordering + idempotency', () => {
  it('happy path: evidence FIRST → TalentRecord (reserved id) → ACCEPTED last → signals; ONE reserved id; no model call', async () => {
    const m = make();
    const res = await m.ctl.create(AUTH, body() as never, 'rq-1');

    // Phase 1 ran, phase 2 created, phase 3 accepted — all once.
    expect(m.establishCreateDraftEvidence).toHaveBeenCalledOnce();
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.markResumeExtractionDraftAccepted).toHaveBeenCalledOnce();

    // ONE reserved talent_id threads through all three phases.
    const reserved = (m.establishCreateDraftEvidence.mock.calls[0]?.[0] as { talent_id: string }).talent_id;
    expect((m.create.mock.calls[0]?.[0] as { id: string }).id).toBe(reserved);
    expect((m.markResumeExtractionDraftAccepted.mock.calls[0]?.[0] as { talent_id: string }).talent_id).toBe(reserved);
    expect(res.id).toBe(reserved);

    // ORDER — evidence establish BEFORE TalentRecord.create BEFORE ACCEPTED.
    expect(m.establishCreateDraftEvidence.mock.invocationCallOrder[0]).toBeLessThan(m.create.mock.invocationCallOrder[0]);
    expect(m.create.mock.invocationCallOrder[0]).toBeLessThan(m.markResumeExtractionDraftAccepted.mock.invocationCallOrder[0]);

    // §4-H signals fire after the durable Talent exists.
    expect(m.enqueueCanonical).toHaveBeenCalledWith(TENANT, reserved);
    expect(m.enqueueTalentReconcile).toHaveBeenCalledWith(TENANT, reserved);
  });

  it('failure during the evidence transaction → NO TalentRecord, draft NOT accepted', async () => {
    const m = make({ establishThrows: new Error('evidence tx failed') });
    await expect(m.ctl.create(AUTH, body() as never, 'rq-1')).rejects.toThrow();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.markResumeExtractionDraftAccepted).not.toHaveBeenCalled();
  });

  it('failure creating TalentRecord → evidence already durable, draft NOT accepted (recoverable)', async () => {
    const m = make({ createThrows: new Error('talent record insert failed') });
    await expect(m.ctl.create(AUTH, body() as never, 'rq-1')).rejects.toThrow();
    expect(m.establishCreateDraftEvidence).toHaveBeenCalledOnce(); // evidence committed
    expect(m.markResumeExtractionDraftAccepted).not.toHaveBeenCalled(); // draft stays READY_FOR_REVIEW
  });

  it('retry after phase-1 (draft already linked) → reuses reserved id, re-runs NO evidence establish, NO model call', async () => {
    const m = make({ draft: draftRow({ talent_id: 'tal-reserved', talent_document_id: 'doc-x', resume_edition_id: 'ed-x' }) });
    await m.ctl.create(AUTH, body() as never, 'rq-1');
    expect(m.establishCreateDraftEvidence).not.toHaveBeenCalled(); // no duplicate evidence / no 2nd LLM
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'tal-reserved' }));
    expect(m.markResumeExtractionDraftAccepted).toHaveBeenCalledWith(expect.objectContaining({ talent_id: 'tal-reserved' }));
  });

  it('retry after phase-2 (TalentRecord exists) + draft not ACCEPTED → closes same draft, NO duplicate Talent', async () => {
    const m = make({
      draft: draftRow({ talent_id: 'tal-reserved', talent_document_id: 'doc-x', resume_edition_id: 'ed-x' }),
      existingTalent: { id: 'tal-reserved', first_name: 'Ada', last_name: 'Lovelace' },
    });
    const res = await m.ctl.create(AUTH, body() as never, 'rq-1');
    expect(m.create).not.toHaveBeenCalled(); // reused, no duplicate Talent
    expect(m.markResumeExtractionDraftAccepted).toHaveBeenCalledOnce();
    expect(res.id).toBe('tal-reserved');
  });

  it('already-ACCEPTED draft (duplicate submit) → returns the existing Talent, NO re-promotion', async () => {
    const m = make({
      draft: draftRow({ status: 'ACCEPTED', talent_id: 'tal-done' }),
      existingTalent: { id: 'tal-done', first_name: 'Ada', last_name: 'Lovelace' },
    });
    const res = await m.ctl.create(AUTH, body() as never, 'rq-1');
    expect(res.id).toBe('tal-done');
    expect(m.establishCreateDraftEvidence).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.markResumeExtractionDraftAccepted).not.toHaveBeenCalled();
  });

  it('lost the phase-1 CAS race → converges on the winner’s reserved id, no duplicate Talent', async () => {
    // establish throws NotReviewable (a concurrent confirm linked first); the re-read
    // returns the winner’s linked identity → reuse it.
    const m = make({ establishThrows: new ResumeExtractionDraftNotReviewableError('draft-1') });
    m.findResumeExtractionDraftById
      .mockResolvedValueOnce(draftRow()) // initial read: unlinked
      .mockResolvedValueOnce(draftRow({ talent_id: 'tal-winner', talent_document_id: 'doc-w', resume_edition_id: 'ed-w' })); // re-read after CAS loss
    const res = await m.ctl.create(AUTH, body() as never, 'rq-1');
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'tal-winner' }));
    expect(res.id).toBe('tal-winner');
  });

  it('a DIFFERENT active record with the same email → 409 (dedup, reserved-id exception aside)', async () => {
    const m = make({ duplicate: { id: 'someone-else' } });
    await expect(m.ctl.create(AUTH, body() as never, 'rq-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'TALENT_RECORD_DUPLICATE',
    });
    expect(m.establishCreateDraftEvidence).not.toHaveBeenCalled();
  });

  it('a missing / non-CREATE draft falls back to the normal create path (returns a record, no ordered flow)', async () => {
    const m = make({ draft: null });
    const res = await m.ctl.create(AUTH, body() as never, 'rq-1');
    // Fell through to normal create (repo.create called without the ordered flow).
    expect(m.establishCreateDraftEvidence).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
