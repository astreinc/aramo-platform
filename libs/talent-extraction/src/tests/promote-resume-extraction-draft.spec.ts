import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// TALENT-INTEL-1 (TI-1F-B) — the EXISTING-Talent CONFIRM promotion. Proves the
// directive invariants at the shaping/orchestration boundary:
//  • §4-F — every promoted evidence row is anchored on source_document_id (the
//    draft's talent_document_id) and NEVER carries the resume_edition_id.
//  • §4-E — the raw typed facts + the draft ACCEPT are handed to ONE atomic repo
//    call (promoteResumeExtractionDraftEvidence); the derived snapshot + the
//    trust assertions are projections that run AFTER that commit.
//  • §6 — one shared extractor: the promotion reads the grounded facts the draft
//    already holds (structured_payload); it NEVER re-invokes a model.
//  • the missing-anchor guard (no talent/document → throw, no promote).

const TENANT = '01900000-0000-7000-8000-000000000001';
const TALENT = '01900000-0000-7000-8000-0000000000aa';
const DOC = '01900000-0000-7000-8000-0000000000dd';
const EDITION = '01900000-0000-7000-8000-0000000000ee';

function makeService(promoteImpl?: () => Promise<unknown>) {
  const promoteResumeExtractionDraftEvidence = vi
    .fn()
    .mockImplementation(
      promoteImpl ??
        (async () => ({
          work_history_ids: [],
          skill_evidence_ids: [],
          project_ids: [],
          education_ids: [],
          certification_ids: [],
        })),
    );
  const createTalentDerivedSnapshot = vi.fn().mockResolvedValue({ id: 'snap' });
  const evidence = { promoteResumeExtractionDraftEvidence, createTalentDerivedSnapshot };
  // The two model surfaces — a promotion reads the persisted grounded facts and
  // MUST NEVER call a model (§6, one shared extractor).
  const generateDraft = vi.fn();
  const generateStructured = vi.fn();
  const recordDeclaredClaimIfAbsent = vi.fn().mockResolvedValue({ written: true });
  const svc = new TalentExtractionService(
    { generateDraft } as never,
    evidence as never,
    { recordDeclaredClaimIfAbsent } as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return {
    svc,
    promoteResumeExtractionDraftEvidence,
    createTalentDerivedSnapshot,
    generateDraft,
    generateStructured,
    recordDeclaredClaimIfAbsent,
  };
}

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'dr-1',
    tenant_id: TENANT,
    source_kind: 'ATTACHMENT',
    source_ref: 'att-1',
    talent_id: TALENT,
    talent_document_id: DOC,
    resume_edition_id: EDITION,
    status: 'READY_FOR_REVIEW',
    structured_payload: {
      source_map_version: 'resume-source-map/v1',
      resume_text_hash: 'h-9',
      work_history: [
        {
          employer_name: 'Northstar',
          role_title: 'Cloud Engineer',
          start_date: '2020',
          end_date: '2023',
          source_refs: ['B004'],
          skill_usage: [
            { surface_form: 'Kubernetes', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', source_refs: ['B004'] },
          ],
          projects: [{ project_name: 'Platform migration', source_refs: ['B004'] }],
        },
      ],
      skills: [{ surface_form: 'C#', source_refs: ['B003'] }],
      education: [{ institution_name: 'MIT', degree_name: 'BSc', source_refs: ['B010'] }],
      certifications: [{ certification_name: 'AWS SA', source_refs: ['B011'] }],
    },
    ...over,
  } as never;
}

describe('TalentExtractionService.promoteResumeExtractionDraft (TI-1F-B)', () => {
  it('promotes the grounded draft facts atomically, anchored on source_document_id — NEVER the edition id (§4-E/§4-F)', async () => {
    const { svc, promoteResumeExtractionDraftEvidence, generateDraft, generateStructured } =
      makeService();
    await svc.promoteResumeExtractionDraft({ draft: draft(), actor_id: 'recruiter-1' });

    // No re-extraction — one shared extractor (§6).
    expect(generateDraft).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();

    // ONE atomic promotion call carrying ALL shaped facts + the review actor.
    expect(promoteResumeExtractionDraftEvidence).toHaveBeenCalledOnce();
    const arg = promoteResumeExtractionDraftEvidence.mock.calls[0]?.[0] as {
      draft_id: string;
      tenant_id: string;
      reviewed_by: string;
      work_history: Array<Record<string, unknown>>;
      skill_evidence: Array<Record<string, unknown>>;
      projects: Array<Record<string, unknown>>;
      education: Array<Record<string, unknown>>;
      certifications: Array<Record<string, unknown>>;
    };
    expect(arg.draft_id).toBe('dr-1');
    expect(arg.tenant_id).toBe(TENANT);
    expect(arg.reviewed_by).toBe('recruiter-1');

    // Work history — one row, anchored on the document, carrying source_refs.
    expect(arg.work_history).toHaveLength(1);
    const wh = arg.work_history[0];
    expect(wh['employer_name']).toBe('Northstar');
    expect(wh['talent_id']).toBe(TALENT);
    expect(wh['source_document_id']).toBe(DOC);
    // Skills = one nested skill_usage + one declared top-level skill.
    expect(arg.skill_evidence).toHaveLength(2);
    const usage = arg.skill_evidence.find((s) => s['surface_form'] === 'Kubernetes');
    expect(usage?.['work_experience_id']).toBe(wh['id']); // linked to the WH row
    expect(usage?.['source_document_id']).toBe(DOC);
    const declared = arg.skill_evidence.find((s) => s['surface_form'] === 'C#');
    expect(declared?.['work_experience_id']).toBeUndefined();
    expect(arg.projects).toHaveLength(1);
    expect(arg.projects[0]['source_document_id']).toBe(DOC);
    expect(arg.education).toHaveLength(1);
    expect(arg.education[0]['source_document_id']).toBe(DOC);
    expect(arg.certifications).toHaveLength(1);
    expect(arg.certifications[0]['source_document_id']).toBe(DOC);

    // §4-F — the resume_edition_id is NEVER threaded onto any evidence row.
    const allRows = [
      ...arg.work_history,
      ...arg.skill_evidence,
      ...arg.projects,
      ...arg.education,
      ...arg.certifications,
    ];
    for (const row of allRows) {
      expect(Object.values(row)).not.toContain(EDITION);
      expect(row['resume_edition_id']).toBeUndefined();
      expect(row['source_edition_id']).toBeUndefined();
    }
  });

  it('runs the derived-snapshot projection AFTER the atomic commit (§4-E post-commit)', async () => {
    const order: string[] = [];
    const { svc, createTalentDerivedSnapshot } = makeService(async () => {
      order.push('promote');
      return {
        work_history_ids: [],
        skill_evidence_ids: [],
        project_ids: [],
        education_ids: [],
        certification_ids: [],
      };
    });
    createTalentDerivedSnapshot.mockImplementation(async () => {
      order.push('snapshot');
      return { id: 'snap' };
    });
    await svc.promoteResumeExtractionDraft({ draft: draft(), actor_id: 'recruiter-1' });
    // The snapshot is computed only if datable; this payload has years → snapshot fires.
    expect(order[0]).toBe('promote');
    expect(order).toContain('snapshot');
    expect(order.indexOf('promote')).toBeLessThan(order.indexOf('snapshot'));
  });

  it('a post-commit snapshot failure NEVER un-promotes (best-effort projection)', async () => {
    const { svc, createTalentDerivedSnapshot } = makeService();
    createTalentDerivedSnapshot.mockRejectedValue(new Error('snapshot db down'));
    await expect(
      svc.promoteResumeExtractionDraft({ draft: draft(), actor_id: 'recruiter-1' }),
    ).resolves.toBeDefined(); // the committed promotion result is still returned
  });

  it('throws (no promotion) when the draft lacks a talent/document anchor', async () => {
    const { svc, promoteResumeExtractionDraftEvidence } = makeService();
    await expect(
      svc.promoteResumeExtractionDraft({
        draft: draft({ talent_document_id: null }),
        actor_id: 'recruiter-1',
      }),
    ).rejects.toThrow();
    expect(promoteResumeExtractionDraftEvidence).not.toHaveBeenCalled();
  });
});
