import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import { ResumeExtractionOrchestrator } from '../lib/resume-extraction/resume-extraction.orchestrator.js';
import { ResumeSourceAuthorizer } from '../lib/resume-extraction/resume-source-authorizer.js';

// HF1 Gate-6 confirmed-create provenance sequence (rulings R1/R2/R8) + the
// review-before-create contract. POSITIVE: a résumé-first create creates the
// TalentDocument AFTER the record and threads its id + corpus provenance onto
// BOTH work-history and skill evidence. NEGATIVE: draft/review (draftFromResume)
// creates NO document and NO evidence — nothing is persisted until Create.

const TENANT = '01900000-0000-7000-8000-000000000001';
const CREATE_AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:create'] } as unknown as AuthContextType;
const READ_AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:read'] } as unknown as AuthContextType;

function makeController(extra: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue({ id: 'tal-new', first_name: 'Ada', last_name: 'Lovelace' });
  const findActiveByEmail = vi.fn().mockResolvedValue(null);
  const repo = { create, findActiveByEmail };
  const createResumeDocument = vi.fn().mockResolvedValue('doc-777');
  const persistDeclaredWorkHistory = vi.fn().mockResolvedValue(['wh-1']);
  const persistDeclaredSkills = vi.fn().mockResolvedValue(['sk-1']);
  const extractResumeDraft = vi.fn();
  const talentExtraction = {
    createResumeDocument,
    persistDeclaredWorkHistory,
    persistDeclaredSkills,
    extractResumeDraft,
    ...extra,
  };
  const tenantSetting = { get: vi.fn().mockResolvedValue('deterministic') };
  const resumeParser = {
    parseFromStorageKey: vi.fn().mockResolvedValue({ prefill: {}, parse_status: 'partial' }),
    extractTextFromStorageKey: vi.fn().mockResolvedValue(null),
  };
  // TI-1B — real authorizer + orchestrator over the fake parser/extraction.
  const authorizer = new ResumeSourceAuthorizer();
  const orchestrator = new ResumeExtractionOrchestrator(
    authorizer,
    resumeParser as never,
    talentExtraction as never,
  );
  const ctl = new TalentRecordController(
    repo as never,
    {} as never,
    {} as never,
    resumeParser as never,
    tenantSetting as never,
    talentExtraction as never,
    orchestrator,
    authorizer,
    // TI-1D-A — reconcileRepo (field-state writes; no-op fake on this path).
    { upsertProfileFieldState: async () => undefined, releaseProjectionHold: async () => undefined, listProfileFieldStates: async () => [] } as never,
  );
  return { ctl, createResumeDocument, persistDeclaredWorkHistory, persistDeclaredSkills, extractResumeDraft };
}

describe('create — HF1 confirmed-create provenance (R1/R2/R8)', () => {
  it('creates the résumé TalentDocument then threads its id + provenance onto WH + skill evidence', async () => {
    const { ctl, createResumeDocument, persistDeclaredWorkHistory, persistDeclaredSkills } =
      makeController();
    const body = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '555-0100',
      work_history: [{ employer_name: 'Northstar', role_title: 'Cloud Engineer', source_refs: ['B004'] }],
      skills: [{ surface_form: 'C#', source_refs: ['B003'] }],
      resume_document: {
        storage_key: 's3/resume.pdf',
        file_name: 'resume.pdf',
        mime_type: 'application/pdf',
        size_bytes: 42,
        source_map_version: 'resume-source-map/v1',
        resume_text_hash: 'hash-9',
      },
    };
    const res = await ctl.create(CREATE_AUTH, body as never, 'rq-1');
    expect(res.id).toBe('tal-new');

    // R1 — the document is created for the confirmed talent, off the résumé key.
    expect(createResumeDocument).toHaveBeenCalledOnce();
    expect(createResumeDocument.mock.calls[0][0]).toMatchObject({
      talent_id: 'tal-new',
      tenant_id: TENANT,
      storage_key: 's3/resume.pdf',
      filename: 'resume.pdf',
    });

    const expectedProvenance = {
      source_document_id: 'doc-777',
      source_map_version: 'resume-source-map/v1',
      resume_text_hash: 'hash-9',
    };
    // R8 — work-history persisted with the threaded document id + corpus.
    expect(persistDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-new',
      tenant_id: TENANT,
      entries: body.work_history,
      provenance: expectedProvenance,
    });
    // R2 — skill evidence persisted with the SAME provenance.
    expect(persistDeclaredSkills).toHaveBeenCalledWith({
      talent_id: 'tal-new',
      tenant_id: TENANT,
      skills: body.skills,
      provenance: expectedProvenance,
    });
  });

  it('no résumé document → no document created, provenance empty (pre-HF1 body)', async () => {
    const { ctl, createResumeDocument, persistDeclaredWorkHistory, persistDeclaredSkills } =
      makeController();
    const body = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '555-0100',
      work_history: [{ employer_name: 'Acme', role_title: 'Engineer' }],
    };
    await ctl.create(CREATE_AUTH, body as never, 'rq-1');
    expect(createResumeDocument).not.toHaveBeenCalled();
    expect(persistDeclaredWorkHistory).toHaveBeenCalledWith({
      talent_id: 'tal-new',
      tenant_id: TENANT,
      entries: body.work_history,
      provenance: {},
    });
    expect(persistDeclaredSkills).not.toHaveBeenCalled(); // no skills on body
  });

  it('best-effort: a document/evidence write error does NOT fail the create', async () => {
    const { ctl } = makeController({
      createResumeDocument: vi.fn().mockRejectedValue(new Error('doc write failed')),
    });
    const body = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '555-0100',
      resume_document: { storage_key: 's3/r.pdf', file_name: 'r.pdf', mime_type: 'application/pdf', size_bytes: 1 },
    };
    const res = await ctl.create(CREATE_AUTH, body as never, 'rq-1');
    expect(res.id).toBe('tal-new'); // record still created
  });
});

describe('draft/review — NOTHING is persisted before Create (review-before-create)', () => {
  it('draftFromResume creates no document and no evidence rows', async () => {
    const { ctl, createResumeDocument, persistDeclaredWorkHistory, persistDeclaredSkills } =
      makeController();
    // deterministic mode (default) → parseFromStorageKey path; no persistence.
    // TI-1B — a VALID Aramo résumé key under the authenticated tenant (the
    // authorizer now guards the deterministic path too).
    const validKey = `${TENANT}/talent/01900000-0000-7000-8000-0000000000aa/resume/01900000-0000-7000-8000-0000000000bb-Resume.pdf`;
    await ctl.draftFromResume(READ_AUTH, { storage_key: validKey }, 'rq-1');
    expect(createResumeDocument).not.toHaveBeenCalled();
    expect(persistDeclaredWorkHistory).not.toHaveBeenCalled();
    expect(persistDeclaredSkills).not.toHaveBeenCalled();
  });
});
