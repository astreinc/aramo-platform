import { describe, expect, it, vi } from 'vitest';
import { buildResumeSourceMap } from '@aramo/resume-parse';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// TALENT-INTEL-1 TI-1D-C — the résumé-edition routes (GET list / POST ingest /
// PUT default). Multiple editions coexist; the default is explicit (never
// latest-wins); POST authors NO work-history/skill evidence.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:edit', 'talent:read'] } as unknown as AuthContextType;

function projectedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ed-1',
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
    ...over,
  };
}

function make(parts: {
  view?: unknown;
  editions?: unknown[];
  resolveMeta?: unknown;
  text?: string | null;
  editionById?: unknown;
} = {}) {
  const findById = vi.fn().mockResolvedValue(parts.view === undefined ? { id: TALENT } : parts.view);
  const repo = { findById };
  const listResumeEditionsWithDocument = vi.fn().mockResolvedValue(parts.editions ?? [projectedRow()]);
  const createResumeDocument = vi.fn().mockResolvedValue('doc-new');
  const findResumeEditionById = vi.fn().mockResolvedValue(
    parts.editionById === undefined
      ? { id: 'ed-1', tenant_id: TENANT, talent_id: TALENT }
      : parts.editionById,
  );
  const setDefaultResumeEdition = vi.fn().mockResolvedValue({});
  const talentExtraction = { listResumeEditionsWithDocument, createResumeDocument, findResumeEditionById, setDefaultResumeEdition };
  const resumeParser = {
    extractTextFromStorageKey: vi.fn().mockResolvedValue(parts.text === undefined ? 'Alan Turing résumé' : parts.text),
  };
  const resolveOwnedResume = vi.fn().mockResolvedValue(
    parts.resolveMeta ?? { storage_key: 's3/r.pdf', filename: 'resume.pdf', mime_type: 'application/pdf', size_bytes: 42 },
  );
  const resumeResolver = { resolveOwnedResume };
  const createEditionForDocument = vi
    .fn()
    .mockResolvedValue({ edition: projectedRow({ id: 'ed-new', talent_document_id: 'doc-new' }), is_default: false, created: true });
  const editionIngestion = { createEditionForDocument };
  const enqueueReindex = vi.fn().mockResolvedValue(undefined);
  const resumeText = { enqueueReindex };

  const ctl = new TalentRecordController(
    repo as never, {} as never, {} as never, resumeParser as never,
    talentExtraction as never, {} as never, {} as never,
    undefined, // canonicalReconcile
    editionIngestion as never,
    resumeResolver as never,
    resumeText as never,
  );
  return { ctl, findById, listResumeEditionsWithDocument, createResumeDocument, createEditionForDocument, resolveOwnedResume, enqueueReindex, findResumeEditionById, setDefaultResumeEdition };
}

describe('TI-1D-C — GET :id/resume-editions', () => {
  it('returns the projected edition collection', async () => {
    const { ctl } = make({ editions: [projectedRow({ id: 'ed-a', is_default: true }), projectedRow({ id: 'ed-b', is_default: false })] });
    const res = await ctl.listResumeEditions(AUTH, TALENT, 'rq-1');
    expect(res.talent_id).toBe(TALENT);
    expect(res.editions.map((e) => e.edition_id)).toEqual(['ed-a', 'ed-b']);
    expect(res.editions[0].is_default).toBe(true);
    expect(res.editions[0].filename).toBe('resume.pdf'); // projected from document
    expect(res.editions[0].uploaded_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('404 when the talent is not in the tenant', async () => {
    const { ctl } = make({ view: null });
    await expect(ctl.listResumeEditions(AUTH, 'missing', 'rq-1')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('TI-1D-C — POST :id/resume-editions', () => {
  it('resolves the owned attachment, extracts+hashes, mints the document, creates the edition, associates text', async () => {
    const { ctl, resolveOwnedResume, createResumeDocument, createEditionForDocument, enqueueReindex } = make();
    await ctl.createResumeEdition(AUTH, TALENT, { attachment_id: 'att-1', purpose: 'CLIENT_SUBMITTAL', label: 'GenAI' } as never, 'rq-1');

    expect(resolveOwnedResume).toHaveBeenCalledWith(expect.objectContaining({ attachment_id: 'att-1', talent_id: TALENT, tenant_id: TENANT }));
    expect(createResumeDocument).toHaveBeenCalledWith(expect.objectContaining({ storage_key: 's3/r.pdf', filename: 'resume.pdf', mime_type: 'application/pdf', size_bytes: 42, talent_id: TALENT }));
    const expectedHash = buildResumeSourceMap('Alan Turing résumé').text_hash;
    expect(createEditionForDocument).toHaveBeenCalledWith(
      expect.objectContaining({ talent_document_id: 'doc-new', content_hash: expectedHash, attachment_id: 'att-1', purpose: 'CLIENT_SUBMITTAL', label: 'GenAI' }),
    );
    // §D — the résumé-text cache is associated with the producing edition.
    expect(enqueueReindex).toHaveBeenCalledWith(expect.objectContaining({ talent_record_id: TALENT, resume_edition_id: 'ed-new' }));
  });

  it('422 when the résumé text cannot be extracted', async () => {
    const { ctl, createResumeDocument } = make({ text: null });
    await expect(ctl.createResumeEdition(AUTH, TALENT, { attachment_id: 'att-1' } as never, 'rq-1')).rejects.toMatchObject({ statusCode: 422 });
    expect(createResumeDocument).not.toHaveBeenCalled(); // no document minted for an unreadable résumé
  });
});

describe('TI-1D-C — PUT :id/resume-editions/default', () => {
  it('explicitly sets the default to a validated edition and returns the collection', async () => {
    const { ctl, setDefaultResumeEdition } = make();
    const res = await ctl.setDefaultResumeEdition(AUTH, TALENT, { resume_edition_id: 'ed-1' } as never, 'rq-1');
    expect(setDefaultResumeEdition).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, talent_id: TALENT, resume_edition_id: 'ed-1', set_by: 'me' }));
    expect(res.talent_id).toBe(TALENT);
  });

  it('404 when the edition does not belong to this talent', async () => {
    const { ctl, setDefaultResumeEdition } = make({ editionById: { id: 'ed-x', tenant_id: TENANT, talent_id: 'other-talent' } });
    await expect(ctl.setDefaultResumeEdition(AUTH, TALENT, { resume_edition_id: 'ed-x' } as never, 'rq-1')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(setDefaultResumeEdition).not.toHaveBeenCalled();
  });
});
