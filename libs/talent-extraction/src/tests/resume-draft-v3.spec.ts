import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';
import type { ResumeSourceMap } from '../lib/dto/extraction.dto.js';

// HF2 v3 (§41) — Talent-Experience-Intelligence extraction acceptance tests
// against a MOCKED structured-generation port. Prove: version extraction, no
// inference, skill-context (cross-role) linkage, multi-role employers, projects
// (never invented), education/certifications, independent nested grounding, and
// NON-SILENT overflow.

const TENANT = '01900000-0000-7000-8000-000000000001';

function mapOf(blocks: Array<{ id: string; text: string }>): ResumeSourceMap {
  let cursor = 0;
  const mapped = blocks.map((b) => {
    const char_start = cursor;
    const char_end = char_start + b.text.length;
    cursor = char_end + 1;
    return { block_id: b.id, text: b.text, char_start, char_end };
  });
  return { version: 'resume-source-map/v1', text_hash: `h-${blocks.length}`, blocks: mapped };
}

type Outcome =
  | { kind: 'ok'; parsed: unknown; transport: Record<string, unknown> }
  | { kind: 'retryable' | 'terminal'; category: string };

function ok(parsed: Record<string, unknown>): Outcome {
  // v3 completion requires skills/work_history/education/certifications arrays.
  return {
    kind: 'ok',
    parsed: { skills: [], work_history: [], education: [], certifications: [], ...parsed },
    transport: { model_used: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 80, provider_request_id: 'r' },
  };
}

function svcWith(outcome: Outcome): TalentExtractionService {
  const generateStructured = vi.fn().mockResolvedValue(outcome);
  return new TalentExtractionService(
    { generateDraft: vi.fn() } as never,
    {} as never,
    {} as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
}

describe('extractResumeDraft v3 — experience intelligence', () => {
  it('version extraction: "17" grounded → version kept; absent → no version (R16)', async () => {
    const m = mapOf([
      { id: 'B001', text: 'Fannie Mae' },
      { id: 'B002', text: 'Cloud Engineer' },
      { id: 'B003', text: 'Built services with Java 17 and Python' },
    ]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Fannie Mae',
            role_title: 'Cloud Engineer',
            source_refs: ['B001', 'B002'],
            skill_usage: [
              { surface_form: 'Java', version: '17', activity: 'DEVELOP', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', source_refs: ['B003'] },
              { surface_form: 'Python', source_refs: ['B003'] },
            ],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const su = out.proposal.work_history[0]?.skill_usage ?? [];
    expect(su.find((s) => s.surface_form === 'Java')?.version).toBe('17');
    expect(su.find((s) => s.surface_form === 'Java')?.usage_period_basis).toBe('WORK_EXPERIENCE_CONTEXT');
    expect(su.find((s) => s.surface_form === 'Python')?.version).toBeUndefined();
  });

  it('no inference: an unstated version is dropped (not grounded), skill kept (R16/R33)', async () => {
    const m = mapOf([{ id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' }, { id: 'B003', text: 'Used Java' }]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Acme',
            role_title: 'Engineer',
            source_refs: ['B001', 'B002'],
            // Model hallucinated a version not in the text — must be dropped.
            skill_usage: [{ surface_form: 'Java', version: '21', source_refs: ['B003'] }],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const java = out.proposal.work_history[0]?.skill_usage?.[0];
    expect(java?.surface_form).toBe('Java');
    expect(java?.version).toBeUndefined(); // '21' not in blocks → dropped, skill survives
  });

  it('cross-role leakage guard: a skill only attaches to the role whose refs support it', async () => {
    const m = mapOf([
      { id: 'B001', text: 'Northstar' }, { id: 'B002', text: 'Backend Engineer' }, { id: 'B003', text: 'Java services' },
      { id: 'B004', text: 'Acme' }, { id: 'B005', text: 'Data Engineer' }, { id: 'B006', text: 'Python pipelines' },
    ]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Northstar', role_title: 'Backend Engineer', source_refs: ['B001', 'B002'],
            // Kafka is NOT in B003 → must be rejected for this role (no leakage).
            skill_usage: [
              { surface_form: 'Java', source_refs: ['B003'] },
              { surface_form: 'Kafka', source_refs: ['B003'] },
            ],
          },
          {
            employer_name: 'Acme', role_title: 'Data Engineer', source_refs: ['B004', 'B005'],
            skill_usage: [{ surface_form: 'Python', source_refs: ['B006'] }],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.work_history).toHaveLength(2);
    expect(out.proposal.work_history[0]?.skill_usage?.map((s) => s.surface_form)).toEqual(['Java']); // Kafka rejected
    expect(out.proposal.work_history[1]?.skill_usage?.map((s) => s.surface_form)).toEqual(['Python']);
    expect(out.proposal.rejected_count).toBe(1); // Kafka
  });

  it('one bad nested fact does NOT destroy the WorkExperience or its siblings', async () => {
    const m = mapOf([{ id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' }, { id: 'B003', text: 'Java and Go' }]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Acme', role_title: 'Engineer', source_refs: ['B001', 'B002'],
            skill_usage: [
              { surface_form: 'Java', source_refs: ['B003'] },
              { surface_form: 'Rust', source_refs: ['B999'] }, // bad ref → drop this one only
              { surface_form: 'Go', source_refs: ['B003'] },
            ],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.work_history).toHaveLength(1);
    expect(out.proposal.work_history[0]?.skill_usage?.map((s) => s.surface_form)).toEqual(['Java', 'Go']);
  });

  it('projects: a NAMED project must ground; an unnamed initiative is allowed; never invented', async () => {
    const m = mapOf([
      { id: 'B001', text: 'Fannie Mae' }, { id: 'B002', text: 'Engineer' },
      { id: 'B003', text: 'Loan Servicing Modernization using Java' }, { id: 'B004', text: 'internal tooling' },
    ]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Fannie Mae', role_title: 'Engineer', source_refs: ['B001', 'B002'],
            projects: [
              { project_name: 'Loan Servicing Modernization', context: 'platform work', source_refs: ['B003'] },
              { context: 'internal tooling', source_refs: ['B004'] }, // unnamed — allowed
              { project_name: 'Phantom Project', source_refs: ['B004'] }, // name not in B004 → rejected
            ],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const projects = out.proposal.work_history[0]?.projects ?? [];
    expect(projects).toHaveLength(2);
    expect(projects[0]?.project_name).toBe('Loan Servicing Modernization');
    expect(projects[1]?.project_name).toBeUndefined(); // unnamed preserved, not invented
    expect(out.proposal.rejected_count).toBe(1); // Phantom Project
  });

  it('assertions: metric only when grounded; ungrounded metric dropped (R17)', async () => {
    const m = mapOf([{ id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' }, { id: 'B003', text: 'Reduced processing time by 40%' }]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Acme', role_title: 'Engineer', source_refs: ['B001', 'B002'],
            assertions: [
              { type: 'DEVELOP', statement: 'Reduced processing time', metric: '40%', source_refs: ['B003'] },
              { type: 'DEVELOP', statement: 'Improved throughput', metric: '99%', source_refs: ['B003'] }, // 99% not in block → metric dropped
            ],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const a = out.proposal.work_history[0]?.assertions ?? [];
    expect(a[0]?.metric).toBe('40%');
    expect(a[1]?.metric).toBeUndefined(); // invented metric dropped, assertion kept
    // P4 ruling — assertions are stamped as source-associated interpretations.
    expect(a[0]?.grounding_class).toBe('SOURCE_ASSOCIATED_INTERPRETATION');
  });

  it('P4 ruling: WORK_EXPERIENCE_CONTEXT skill dates are NULLED (resolved from role later); EXPLICIT dates kept', async () => {
    const m = mapOf([
      { id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' },
      { id: 'B003', text: 'Java 2019 to 2021' }, { id: 'B004', text: 'Go' },
    ]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Acme', role_title: 'Engineer', source_refs: ['B001', 'B002'],
            skill_usage: [
              // EXPLICIT — stated skill dates kept.
              { surface_form: 'Java', usage_period_basis: 'EXPLICIT', usage_start: '2019', usage_end: '2021', source_refs: ['B003'] },
              // CONTEXT — model tried to manufacture dates; must be NULLED.
              { surface_form: 'Go', usage_period_basis: 'WORK_EXPERIENCE_CONTEXT', usage_start: '2019', usage_end: '2021', source_refs: ['B004'] },
            ],
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const su = out.proposal.work_history[0]?.skill_usage ?? [];
    const java = su.find((s) => s.surface_form === 'Java');
    const go = su.find((s) => s.surface_form === 'Go');
    expect(java?.usage_start).toBe('2019');
    expect(java?.usage_end).toBe('2021');
    expect(go?.usage_start).toBeUndefined(); // context dates dropped
    expect(go?.usage_end).toBeUndefined();
    expect(go?.usage_period_basis).toBe('WORK_EXPERIENCE_CONTEXT'); // basis preserved
  });

  it('education + certifications grounded and carried (R8/R18/R19)', async () => {
    const m = mapOf([
      { id: 'B001', text: 'BS Computer Science, MIT' },
      { id: 'B002', text: 'AWS Certified Solutions Architect' },
    ]);
    const out = await svcWith(
      ok({
        education: [{ institution_name: 'MIT', degree_name: 'BS Computer Science', source_refs: ['B001'] }],
        certifications: [{ certification_name: 'AWS Certified Solutions Architect', source_refs: ['B002'] }],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.education[0]?.institution_name).toBe('MIT');
    expect(out.proposal.certifications[0]?.certification_name).toBe('AWS Certified Solutions Architect');
  });

  it('NON-SILENT overflow: >ceiling skill_usage truncates, flags overflow, status=partial (R12)', async () => {
    const skills = Array.from({ length: 35 }, (_, i) => `Skill${i}`);
    const m = mapOf([{ id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' }, { id: 'B003', text: skills.join(' ') }]);
    const out = await svcWith(
      ok({
        work_history: [
          {
            employer_name: 'Acme', role_title: 'Engineer', source_refs: ['B001', 'B002'],
            skill_usage: skills.map((s) => ({ surface_form: s, source_refs: ['B003'] })),
          },
        ],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.work_history[0]?.skill_usage?.length).toBe(30); // capped
    expect(out.proposal.overflow).toBe(true); // visible, not silent
    expect(out.status).toBe('partial');
  });

  it('experience_summary is capped at 600 chars, one line (R10)', async () => {
    const long = `Led ${'work '.repeat(300)}initiatives`;
    const m = mapOf([{ id: 'B001', text: 'Acme' }, { id: 'B002', text: 'Engineer' }]);
    const out = await svcWith(
      ok({
        work_history: [{ employer_name: 'Acme', role_title: 'Engineer', experience_summary: long, source_refs: ['B001', 'B002'] }],
      }),
    ).extractResumeDraft({ tenant_id: TENANT, source_map: m });
    const s = out.proposal.work_history[0]?.experience_summary ?? '';
    expect(s.length).toBeLessThanOrEqual(600);
    expect(s).not.toContain('\n');
  });

  it('C: schema declares cardinality ceilings + activity enum + no source_excerpt', async () => {
    const generateStructured = vi.fn().mockResolvedValue(ok({}));
    const svc = new TalentExtractionService(
      { generateDraft: vi.fn() } as never, {} as never, {} as never,
      { generateStructured, providerKey: () => 'anthropic' } as never,
    );
    await svc.extractResumeDraft({ tenant_id: TENANT, source_map: mapOf([{ id: 'B001', text: 'x' }]) });
    const schema = generateStructured.mock.calls[0][0].json_schema;
    expect(JSON.stringify(schema)).not.toContain('source_excerpt');
    expect(schema.properties.work_history.maxItems).toBe(20);
    expect(schema.properties.work_history.items.properties.skill_usage.maxItems).toBe(30);
    expect(schema.properties.work_history.items.properties.projects.maxItems).toBe(10);
    expect(schema.properties.education.maxItems).toBe(10);
    expect(schema.properties.certifications.maxItems).toBe(20);
    expect(schema.properties.work_history.items.properties.experience_summary.maxLength).toBe(600);
    // Governed activity enum present (R13).
    expect(schema.properties.work_history.items.properties.skill_usage.items.properties.activity.enum).toContain('DEVELOP');
  });
});
