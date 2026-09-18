import { describe, expect, it, vi } from 'vitest';

import { ResumeEditionIngestionService } from '../lib/resume-extraction/resume-edition-ingestion.service.js';

// TALENT-INTEL-1 TI-1D-C §A/§B — the shared edition-ingestion composition.
// createEditionForDocument creates exactly ONE edition per TalentDocument
// (idempotent on talent_document_id), establishes the default ONLY for the first
// edition, and NEVER changes the default for later editions (no latest==truth).

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '55555555-5555-7555-8555-555555555555';

function edition(id: string, doc: string) {
  return {
    id,
    tenant_id: TENANT,
    talent_id: TALENT,
    talent_document_id: doc,
    attachment_id: null,
    content_hash: 'h',
    purpose: 'GENERAL',
    label: null,
    requisition_id: null,
    client_context_id: null,
    derived_from_edition_id: null,
    lifecycle_status: 'active',
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    created_by: ACTOR,
  };
}

function make(parts: { existingForDoc?: unknown; existingDefault?: unknown } = {}) {
  const findResumeEditionByDocument = vi
    .fn()
    .mockResolvedValue(parts.existingForDoc ?? null);
  const createResumeEdition = vi
    .fn()
    .mockImplementation((input: { talent_document_id: string; id: string }) =>
      Promise.resolve(edition(input.id, input.talent_document_id)),
    );
  const getDefaultResumeEdition = vi
    .fn()
    .mockResolvedValue(parts.existingDefault ?? null);
  const setDefaultResumeEdition = vi.fn().mockResolvedValue({});
  const talentExtraction = {
    findResumeEditionByDocument,
    createResumeEdition,
    getDefaultResumeEdition,
    setDefaultResumeEdition,
  };
  const service = new ResumeEditionIngestionService(talentExtraction as never);
  return { service, findResumeEditionByDocument, createResumeEdition, getDefaultResumeEdition, setDefaultResumeEdition };
}

const base = {
  tenant_id: TENANT,
  talent_id: TALENT,
  talent_document_id: '44444444-4444-7444-8444-444444444444',
  content_hash: 'hash-a',
  created_by: ACTOR,
};

describe('ResumeEditionIngestionService.createEditionForDocument', () => {
  it('FIRST edition (no default exists) → creates edition AND establishes the default', async () => {
    const { service, createResumeEdition, setDefaultResumeEdition } = make();
    const res = await service.createEditionForDocument(base);
    expect(createResumeEdition).toHaveBeenCalledOnce();
    expect(setDefaultResumeEdition).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_id: TALENT, resume_edition_id: res.edition.id, set_by: ACTOR }),
    );
    expect(res.is_default).toBe(true);
    expect(res.created).toBe(true);
  });

  it('LATER edition (a default already exists) → creates but NEVER changes the default', async () => {
    const { service, createResumeEdition, setDefaultResumeEdition } = make({
      existingDefault: { resume_edition_id: 'ed-old', tenant_id: TENANT, talent_id: TALENT },
    });
    const res = await service.createEditionForDocument({
      ...base,
      talent_document_id: '44444444-4444-7444-8444-444444444445',
    });
    expect(createResumeEdition).toHaveBeenCalledOnce();
    expect(setDefaultResumeEdition).not.toHaveBeenCalled(); // default untouched
    expect(res.is_default).toBe(false);
    expect(res.created).toBe(true);
  });

  it('RETRY for the same document → returns the existing edition, creates nothing', async () => {
    const existing = edition('ed-existing', base.talent_document_id);
    const { service, createResumeEdition, setDefaultResumeEdition } = make({
      existingForDoc: existing,
      existingDefault: { resume_edition_id: 'ed-existing' },
    });
    const res = await service.createEditionForDocument(base);
    expect(createResumeEdition).not.toHaveBeenCalled();
    expect(setDefaultResumeEdition).not.toHaveBeenCalled();
    expect(res.edition.id).toBe('ed-existing');
    expect(res.is_default).toBe(true);
    expect(res.created).toBe(false);
  });
});
