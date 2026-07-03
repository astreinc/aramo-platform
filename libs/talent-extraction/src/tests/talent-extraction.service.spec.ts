import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';
import { deriveSkillId } from '../lib/skill-id.js';

// Gate-1 G1-A — TalentExtractionService deterministic post-processing.
//
// The generateDraft call is the ai-draft path (mocked here). What is tested is
// the DETERMINISTIC core: JSON parse/validate, constrained-to-source guardrail
// (an item with no verbatim source excerpt is REJECTED, never persisted),
// deterministic skill_id derivation, and the `declared` evidence write shape.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

function makeService(completion: string) {
  const aiDraft = {
    generateDraft: vi.fn().mockResolvedValue({
      completion,
      model_used: 'test',
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
      audit_record_id: 'audit-1',
    }),
  };
  const evidence = {
    createTalentSkillEvidence: vi.fn().mockResolvedValue({}),
    createTalentWorkHistoryEntry: vi.fn().mockResolvedValue({}),
  };
  const svc = new TalentExtractionService(aiDraft as never, evidence as never);
  return { svc, aiDraft, evidence };
}

describe('TalentExtractionService.extractDeclaredEvidence', () => {
  it('persists sourced skills as declared evidence with deterministic skill_id + evidence_text', async () => {
    const resume = 'Senior engineer. Skilled in AWS and PostgreSQL. 5 years with Go.';
    const completion = JSON.stringify({
      skills: [
        { surface_form: 'AWS', source_excerpt: 'Skilled in AWS and PostgreSQL' },
        { surface_form: 'Go', source_excerpt: '5 years with Go', years_claimed: 5 },
      ],
      work_history: [],
    });
    const { svc, evidence } = makeService(completion);

    const out = await svc.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: resume,
    });

    expect(out.skill_evidence_ids).toHaveLength(2);
    expect(out.rejected_count).toBe(0);
    expect(evidence.createTalentSkillEvidence).toHaveBeenCalledTimes(2);

    const first = evidence.createTalentSkillEvidence.mock.calls[0]![0];
    expect(first).toMatchObject({
      talent_id: TALENT,
      tenant_id: TENANT,
      surface_form: 'AWS',
      source: 'declared',
      evidence_text: 'Skilled in AWS and PostgreSQL',
      skill_id: deriveSkillId('AWS'),
    });
    // confidence_score is NEVER set for declared rows (R3).
    expect(first).not.toHaveProperty('confidence_score');

    // years_claimed passed through only when the model stated it.
    const second = evidence.createTalentSkillEvidence.mock.calls[1]![0];
    expect(second.years_claimed).toBe(5);
  });

  it('CONSTRAINED-TO-SOURCE: rejects an item whose excerpt is not in the source (no persist)', async () => {
    const resume = 'Skilled in AWS.';
    const completion = JSON.stringify({
      skills: [
        { surface_form: 'AWS', source_excerpt: 'Skilled in AWS.' },
        // Hallucinated — the excerpt is NOT anywhere in the source text.
        { surface_form: 'Kubernetes', source_excerpt: 'Expert Kubernetes operator' },
      ],
      work_history: [],
    });
    const { svc, evidence } = makeService(completion);

    const out = await svc.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: resume,
    });

    expect(out.skill_evidence_ids).toHaveLength(1);
    expect(out.rejected_count).toBe(1);
    expect(evidence.createTalentSkillEvidence).toHaveBeenCalledTimes(1);
    expect(evidence.createTalentSkillEvidence.mock.calls[0]![0].surface_form).toBe('AWS');
  });

  it('rejects a skill with an empty source_excerpt', async () => {
    const completion = JSON.stringify({
      skills: [{ surface_form: 'AWS', source_excerpt: '' }],
      work_history: [],
    });
    const { svc, evidence } = makeService(completion);
    const out = await svc.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: 'Skilled in AWS.',
    });
    expect(out.skill_evidence_ids).toHaveLength(0);
    expect(out.rejected_count).toBe(1);
    expect(evidence.createTalentSkillEvidence).not.toHaveBeenCalled();
  });

  it('persists sourced work history as declared evidence', async () => {
    const resume = 'Acme Corp — Staff Engineer, 2019 to 2023. Built the platform.';
    const completion = JSON.stringify({
      skills: [],
      work_history: [
        {
          employer_name: 'Acme Corp',
          role_title: 'Staff Engineer',
          source_excerpt: 'Acme Corp — Staff Engineer, 2019 to 2023',
          description: 'Built the platform.',
        },
      ],
    });
    const { svc, evidence } = makeService(completion);

    const out = await svc.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: resume,
    });

    expect(out.work_history_ids).toHaveLength(1);
    expect(evidence.createTalentWorkHistoryEntry).toHaveBeenCalledTimes(1);
    expect(evidence.createTalentWorkHistoryEntry.mock.calls[0]![0]).toMatchObject({
      employer_name: 'Acme Corp',
      role_title: 'Staff Engineer',
      source: 'resume',
      description_text: 'Built the platform.',
    });
  });

  it('handles code-fenced JSON and malformed completions deterministically', async () => {
    const fenced = '```json\n{"skills":[{"surface_form":"Go","source_excerpt":"years with Go"}],"work_history":[]}\n```';
    const { svc, evidence } = makeService(fenced);
    const out = await svc.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: '5 years with Go',
    });
    expect(out.skill_evidence_ids).toHaveLength(1);

    const { svc: svc2, evidence: ev2 } = makeService('not json at all');
    const out2 = await svc2.extractDeclaredEvidence({
      tenant_id: TENANT,
      talent_id: TALENT,
      resume_text: 'anything',
    });
    expect(out2.skill_evidence_ids).toHaveLength(0);
    expect(out2.work_history_ids).toHaveLength(0);
    expect(ev2.createTalentSkillEvidence).not.toHaveBeenCalled();
  });

  it('no-ops (no LLM call) when there is no declared source text', async () => {
    const { svc, aiDraft, evidence } = makeService('{}');
    const out = await svc.extractDeclaredEvidence({ tenant_id: TENANT, talent_id: TALENT });
    expect(out).toEqual({ skill_evidence_ids: [], work_history_ids: [], rejected_count: 0 });
    expect(aiDraft.generateDraft).not.toHaveBeenCalled();
    expect(evidence.createTalentSkillEvidence).not.toHaveBeenCalled();
  });
});

describe('deriveSkillId — deterministic skill_id (R2)', () => {
  it('same surface form (case/whitespace-insensitive) → same id; different → different', () => {
    expect(deriveSkillId('AWS')).toBe(deriveSkillId('aws'));
    expect(deriveSkillId('  Node.js ')).toBe(deriveSkillId('node.js'));
    expect(deriveSkillId('AWS')).not.toBe(deriveSkillId('PostgreSQL'));
    // Stable UUID shape.
    expect(deriveSkillId('AWS')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
