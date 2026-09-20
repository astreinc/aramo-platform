import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import { ResumeExtractionOrchestrator } from '../lib/resume-extraction/resume-extraction.orchestrator.js';
import { ResumeSourceAuthorizer } from '../lib/resume-extraction/resume-source-authorizer.js';

// Add-Talent draft-from-resume — GOVERNED LLM IS THE SOLE production résumé
// fact extractor (TI-1F P0.2; …-TI-1F-…-v1_0-LOCKED §4-D). There is no mode
// toggle and no deterministic fact-extraction branch; an LLM failure yields an
// empty prefill + warning + retry, NEVER a silent fallback to the heuristic
// parser (§15).
//
// TALENT-INTEL-1 (TI-1B) — the governed orchestration lives in
// ResumeExtractionOrchestrator; this spec drives the controller through a REAL
// orchestrator + authorizer over a fake parser/extraction, so the end-to-end
// routing + the ruling-15 authorization both hold. Every request uses a VALID
// Aramo résumé key under the authenticated tenant.

const TENANT = '01900000-0000-7000-8000-000000000001';
const DRAFT = '01900000-0000-7000-8000-0000000000aa';
const FILE_UUID = '01900000-0000-7000-8000-0000000000bb';
const VALID_KEY = `${TENANT}/talent/${DRAFT}/resume/${FILE_UUID}-Resume.pdf`;
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:read'] } as unknown as AuthContextType;

function emptyProposal() {
  return {
    skills: [],
    work_history: [],
    // HF2 v3 — education + certifications are now required proposal arrays.
    education: [],
    certifications: [],
    rejected_count: 0,
    overflow: false,
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'h',
  };
}

function makeController(opts: {
  text?: string | null;
  // HF1 — extractResumeDraft returns { status, proposal }.
  result?: unknown;
  proposalThrows?: boolean;
}) {
  const extractResumeDraft = opts.proposalThrows
    ? vi.fn().mockRejectedValue(new Error('provider unavailable'))
    : vi
        .fn()
        .mockResolvedValue(opts.result ?? { status: 'partial', proposal: emptyProposal() });
  // TI-1F-A — the create seam additively persists a CREATE_DRAFT_UPLOAD draft
  // from the SAME governed result (no second model call). Mocked here.
  const upsertResumeExtractionDraft = vi.fn().mockResolvedValue({ id: 'draft-create-1' });
  const talentExtraction = { extractResumeDraft, upsertResumeExtractionDraft };
  const extractTextFromStorageKey = vi.fn().mockResolvedValue(opts.text ?? null);
  // The résumé parser now exposes ONLY deterministic file→text extraction; the
  // heuristic fact method is gone (TI-1F P0.2), so there is no path to fall back
  // to — governed LLM is structurally the sole extractor.
  const resumeParser = { extractTextFromStorageKey };
  // TI-1B — a REAL authorizer (no ATTACHMENT resolver: this is the CREATE path)
  // and a REAL orchestrator over the fake parser/extraction.
  const authorizer = new ResumeSourceAuthorizer();
  const orchestrator = new ResumeExtractionOrchestrator(
    authorizer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumeParser as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    talentExtraction as any,
  );
  const ctl = new TalentRecordController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumeParser as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    talentExtraction as any,
    orchestrator,
    // TI-1D-A — reconcileRepo (field-state writes; no-op fake on this path).
    { upsertProfileFieldState: async () => undefined, releaseProjectionHold: async () => undefined, listProfileFieldStates: async () => [] } as never,
  );
  return { ctl, extractResumeDraft, upsertResumeExtractionDraft, extractTextFromStorageKey };
}

const SUCCESS_RESULT = {
  status: 'success',
  proposal: {
    first_name: 'Sarah',
    last_name: 'Nolan',
    skills: [],
    work_history: [],
    education: [],
    certifications: [],
    rejected_count: 0,
    overflow: false,
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'h',
  },
};

describe('draft-from-resume — TI-1F-A CREATE_DRAFT_UPLOAD additive persistence', () => {
  it('persists a CREATE_DRAFT_UPLOAD draft from the SAME governed result; ONE model call; response prefill unchanged + additive draft_id', async () => {
    const { ctl, extractResumeDraft, upsertResumeExtractionDraft } = makeController({
      text: 'Sarah Nolan — Cloud Engineer',
      result: SUCCESS_RESULT,
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    // Create UI operational: the synchronous prefill response is unchanged.
    expect(res.prefill.first_name).toBe('Sarah');
    // NO duplicate model call — exactly one governed extraction feeds BOTH the
    // response prefill and the persisted draft.
    expect(extractResumeDraft).toHaveBeenCalledOnce();
    // Draft persisted from that SAME result — pre-Talent (no talent_id/doc/edition).
    expect(upsertResumeExtractionDraft).toHaveBeenCalledOnce();
    const draftArg = upsertResumeExtractionDraft.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draftArg['source_kind']).toBe('CREATE_DRAFT_UPLOAD');
    expect(draftArg['source_ref']).toBe(VALID_KEY);
    expect(draftArg['status']).toBe('READY_FOR_REVIEW');
    expect(draftArg['talent_id'] ?? null).toBeNull();
    expect(draftArg['talent_document_id'] ?? null).toBeNull();
    expect(draftArg['resume_edition_id'] ?? null).toBeNull();
    expect((draftArg['structured_payload'] as { prefill: { first_name: string } }).prefill.first_name).toBe('Sarah');
    // Additive draft_id on the response (the current Create form ignores it).
    expect(res.draft_id).toBe('draft-create-1');
  });

  it('draft persistence is NON-BLOCKING — a draft-write failure never affects the prefill response (Create UI stays operational)', async () => {
    const { ctl, upsertResumeExtractionDraft } = makeController({
      text: 'Sarah Nolan — Cloud Engineer',
      result: SUCCESS_RESULT,
    });
    upsertResumeExtractionDraft.mockRejectedValueOnce(new Error('draft store unavailable'));
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.prefill.first_name).toBe('Sarah'); // response intact
    expect(res.draft_id).toBeUndefined(); // no draft_id when persistence failed
  });
});

describe('draft-from-resume — governed-LLM sole extractor', () => {
  it('empty storage_key → VALIDATION_ERROR', async () => {
    const { ctl } = makeController({});
    await expect(
      ctl.draftFromResume(AUTH, { storage_key: '' }, 'rq-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('governed LLM is the SOLE extractor; key_skills from surface_forms; source_refs + status carried', async () => {
    const { ctl, extractResumeDraft, extractTextFromStorageKey } = makeController({
      text: 'Sarah Nolan — Cloud Engineer, Austin TX. Skills: C#, Azure SQL',
      result: {
        status: 'success',
        proposal: {
          first_name: 'Sarah',
          last_name: 'Nolan',
          skills: [
            { surface_form: 'C#', source_refs: ['B003'] },
            { surface_form: 'Azure SQL', source_refs: ['B003'] },
          ],
          work_history: [
            { employer_name: 'Northstar', role_title: 'Engineer', source_refs: ['B004'] },
          ],
          education: [],
          certifications: [],
          rejected_count: 0,
          overflow: false,
          source_map_version: 'resume-source-map/v1',
          resume_text_hash: 'h',
        },
      },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.extraction_status).toBe('success');
    expect(res.prefill.first_name).toBe('Sarah');
    // key_skills derived from the structured surface_forms (R7).
    expect(res.prefill.key_skills).toBe('C#, Azure SQL');
    // Work-history rides the response carrying source_refs; NEVER a description (R4).
    expect(res.work_history).toEqual([
      { employer_name: 'Northstar', role_title: 'Engineer', source_refs: ['B004'] },
    ]);
    expect(res.work_history?.[0]).not.toHaveProperty('description');
    // Structured skills + refs carried for durable provenance (R7).
    expect(res.skills).toEqual([
      { surface_form: 'C#', source_refs: ['B003'] },
      { surface_form: 'Azure SQL', source_refs: ['B003'] },
    ]);
    // Email/phone are NEVER LLM-proposed; they come only from local extraction
    // (R17) — this sample text carries none, so they stay absent.
    expect(res.prefill.email1).toBeUndefined();
    expect(res.prefill.phone_cell).toBeUndefined();
    expect(extractTextFromStorageKey).toHaveBeenCalledOnce();
    expect(extractResumeDraft).toHaveBeenCalledOnce();
  });

  // HF2 R17 — the hybrid split: EMAIL/PHONE arrive on result.contact (captured
  // during model-input redaction inside extractResumeDraft — the model never
  // sees them); CITY/STATE/ZIP come from the GROUNDED LLM proposal.
  it('email/phone from result.contact, city/state/ZIP from the proposal (R17)', async () => {
    const { ctl } = makeController({
      text: 'Jane Doe\nMcLean, VA 22102\nSkills: Go',
      result: {
        status: 'success',
        // Captured during redaction (never sent to the model).
        contact: { emails: ['jane@example.com'], phones: ['703-555-1212'] },
        proposal: {
          first_name: 'Jane',
          last_name: 'Doe',
          // Location comes from the model (grounded), NOT a local regex.
          city: 'McLean',
          state: 'VA',
          zip: '22102',
          skills: [{ surface_form: 'Go', source_refs: ['B002'] }],
          work_history: [],
          education: [],
          certifications: [],
          rejected_count: 0,
          overflow: false,
          source_map_version: 'resume-source-map/v1',
          resume_text_hash: 'h',
        },
      },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    // Email/phone: from result.contact (redaction capture).
    expect(res.prefill.email1).toBe('jane@example.com');
    expect(res.prefill.phone_cell).toBe('703-555-1212');
    // City/state/ZIP: from the LLM proposal.
    expect(res.prefill.city).toBe('McLean');
    expect(res.prefill.state).toBe('VA');
    expect(res.prefill.zip).toBe('22102');
  });

  it('provider_truncated → explicit failed status + distinct warning (§13/R9)', async () => {
    const { ctl } = makeController({
      text: 'a very long resume',
      result: { status: 'provider_truncated', proposal: emptyProposal() },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.extraction_status).toBe('provider_truncated');
    expect(res.parse_status).toBe('failed');
    expect(res.prefill).toEqual({});
    expect(res.warning).toMatch(/too long/i);
  });

  it('invalid_structured_output → explicit failed status + retry warning', async () => {
    const { ctl } = makeController({
      text: 'resume',
      result: { status: 'invalid_structured_output', proposal: emptyProposal() },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.extraction_status).toBe('invalid_structured_output');
    expect(res.parse_status).toBe('failed');
    expect(res.warning).toBeDefined();
  });

  it('unreadable résumé (null text) → empty prefill + warning, LLM NOT called', async () => {
    const { ctl, extractResumeDraft } = makeController({ text: null });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.prefill).toEqual({});
    expect(res.parse_status).toBe('failed');
    expect(res.warning).toBeDefined();
    expect(extractResumeDraft).not.toHaveBeenCalled();
  });

  it('LLM error → empty prefill + warning, NO heuristic fallback (§15)', async () => {
    const { ctl } = makeController({
      text: 'some resume text',
      proposalThrows: true,
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: VALID_KEY }, 'rq-1');
    expect(res.prefill).toEqual({});
    expect(res.warning).toBeDefined();
  });
});
