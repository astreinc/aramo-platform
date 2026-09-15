import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';
import type { ResumeSourceMap } from '../lib/dto/extraction.dto.js';

// HF1 Durable-Fact-Extraction — the Add-Talent governed-LLM DRAFT path.
//
// These prove the HF1 architecture against a MOCKED structured-generation port
// (no live model): SINGLE-READ fact+ref extraction (R3), source-map ref
// grounding (R5), per-fact validation (R14), explicit failure states (R9/§13),
// one model call (R6), and the retirement of source_excerpt / work-history
// description (R3/R4). Several of the §24 mandatory acceptance tests (A, C–L,
// refs-survive, privacy) are realised here at the extraction boundary.

const TENANT = '01900000-0000-7000-8000-000000000001';

// Hand-build a source-map fixture INLINE — talent-extraction grounds against a
// structurally-identical value passed by value; it never imports resume-parse
// (R1), so the test does not either.
function mapOf(blocks: Array<{ id: string; text: string }>): ResumeSourceMap {
  let cursor = 0;
  const mapped = blocks.map((b) => {
    const char_start = cursor;
    const char_end = char_start + b.text.length;
    cursor = char_end + 1; // + newline
    return { block_id: b.id, text: b.text, char_start, char_end };
  });
  return {
    version: 'resume-source-map/v1',
    text_hash: `hash-${blocks.map((b) => b.id).join('')}`,
    blocks: mapped,
  };
}

type Outcome =
  | { kind: 'ok'; parsed: unknown; transport: Record<string, unknown> }
  | { kind: 'retryable' | 'terminal'; category: string };

function ok(parsed: unknown): Outcome {
  return {
    kind: 'ok',
    parsed,
    transport: {
      model_used: 'claude-sonnet-4-6',
      input_tokens: 120,
      output_tokens: 40,
      provider_request_id: 'req-1',
    },
  };
}

function makeService(outcome: Outcome): {
  svc: TalentExtractionService;
  generateStructured: ReturnType<typeof vi.fn>;
  generateDraft: ReturnType<typeof vi.fn>;
} {
  const generateStructured = vi.fn().mockResolvedValue(outcome);
  const generateDraft = vi.fn();
  const svc = new TalentExtractionService(
    { generateDraft } as never, // aiDraft — examine path only, never the draft path
    {} as never, // evidence
    {} as never, // trust
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return { svc, generateStructured, generateDraft };
}

const RESUME = mapOf([
  { id: 'B001', text: 'Sarah Nolan' },
  { id: 'B002', text: 'Cloud Engineer — Austin, TX' },
  { id: 'B003', text: 'Skills: C#, ASP.NET Core, Azure SQL' },
  { id: 'B004', text: 'Northstar Systems — Cloud Engineer — 2019 to 2023' },
]);

describe('extractResumeDraft — HF1 structured, source-ref grounded', () => {
  it('A/refs-survive: grounds facts, carries source_refs, status=success', async () => {
    const { svc } = makeService(
      ok({
        identity: { first_name: 'Sarah', last_name: 'Nolan', source_refs: ['B001'] },
        location: { city: 'Austin', state: 'TX', source_refs: ['B002'] },
        professional: {
          current_employer: 'Northstar Systems',
          title: 'Cloud Engineer',
          source_refs: ['B004'],
        },
        skills: [
          { surface_form: 'C#', source_refs: ['B003'] },
          { surface_form: 'ASP.NET Core', source_refs: ['B003'] },
        ],
        work_history: [
          {
            employer_name: 'Northstar Systems',
            role_title: 'Cloud Engineer',
            start_date: '2019',
            source_refs: ['B004'],
          },
        ],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.status).toBe('success');
    expect(out.proposal.first_name).toBe('Sarah');
    expect(out.proposal.last_name).toBe('Nolan');
    expect(out.proposal.city).toBe('Austin');
    expect(out.proposal.current_employer).toBe('Northstar Systems');
    // R7 — structured skills carry their source_refs through the proposal.
    expect(out.proposal.skills).toEqual([
      { surface_form: 'C#', source_refs: ['B003'] },
      { surface_form: 'ASP.NET Core', source_refs: ['B003'] },
    ]);
    // R8 — work-history carries source_refs; NO description field.
    expect(out.proposal.work_history).toEqual([
      {
        employer_name: 'Northstar Systems',
        role_title: 'Cloud Engineer',
        start_date: '2019',
        source_refs: ['B004'],
      },
    ]);
    expect(out.proposal.work_history[0]).not.toHaveProperty('description');
    // §16 — provenance anchors.
    expect(out.proposal.source_map_version).toBe('resume-source-map/v1');
    expect(out.proposal.resume_text_hash).toBe(RESUME.text_hash);
    expect(out.proposal.rejected_count).toBe(0);
  });

  it('L: exactly ONE governed model call per résumé (never the free-text path)', async () => {
    const { svc, generateStructured, generateDraft } = makeService(
      ok({ skills: [], work_history: [] }),
    );
    await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('C/N: the request schema forbids source_excerpt AND work-history description', async () => {
    const { svc, generateStructured } = makeService(ok({ skills: [], work_history: [] }));
    await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    const req = generateStructured.mock.calls[0][0];
    const schema = req.json_schema;
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain('source_excerpt');
    expect(serialized).not.toContain('description');
    // It DOES ask for source_refs on work-history and skills.
    const wh = schema.properties.work_history.items.properties;
    expect(wh).toHaveProperty('source_refs');
    expect(wh).not.toHaveProperty('description');
    expect(schema.properties.skills.items.properties).toHaveProperty('source_refs');
  });

  it('privacy/R10: the model input is REDACTED + block-annotated, never raw PII', async () => {
    const withPii = mapOf([
      { id: 'B001', text: 'Sarah Nolan' },
      { id: 'B002', text: 'Email: sarah.nolan@example.com  Cell: 512-555-1212' },
    ]);
    const { svc, generateStructured } = makeService(ok({ skills: [], work_history: [] }));
    await svc.extractResumeDraft({ tenant_id: TENANT, source_map: withPii });
    const userContent: string = generateStructured.mock.calls[0][0].user_content;
    expect(userContent).toContain('[B001] Sarah Nolan'); // block-annotated
    expect(userContent).toContain('[REDACTED:EMAIL]');
    expect(userContent).toContain('[REDACTED:PHONE]');
    expect(userContent).not.toContain('sarah.nolan@example.com');
    expect(userContent).not.toContain('512-555-1212');
  });

  it('D: multiple jobs with multi-block refs ground correctly', async () => {
    const m = mapOf([
      { id: 'B001', text: 'Northstar Systems' },
      { id: 'B002', text: 'Senior Cloud Engineer' },
      { id: 'B003', text: 'Acme Corp' },
      { id: 'B004', text: 'Platform Engineer' },
    ]);
    const { svc } = makeService(
      ok({
        skills: [],
        work_history: [
          { employer_name: 'Northstar Systems', role_title: 'Senior Cloud Engineer', source_refs: ['B001', 'B002'] },
          { employer_name: 'Acme Corp', role_title: 'Platform Engineer', source_refs: ['B003', 'B004'] },
        ],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.work_history).toHaveLength(2);
    expect(out.proposal.work_history[0]?.source_refs).toEqual(['B001', 'B002']);
    expect(out.proposal.rejected_count).toBe(0);
  });

  it('E: many skills stay compact — grounded + de-duplicated', async () => {
    const m = mapOf([{ id: 'B001', text: 'Skills: C#, Go, Rust, Python, C#' }]);
    const { svc } = makeService(
      ok({
        skills: [
          { surface_form: 'C#', source_refs: ['B001'] },
          { surface_form: 'Go', source_refs: ['B001'] },
          { surface_form: 'Rust', source_refs: ['B001'] },
          { surface_form: 'Python', source_refs: ['B001'] },
          { surface_form: 'C#', source_refs: ['B001'] }, // duplicate → collapsed
        ],
        work_history: [],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: m });
    expect(out.proposal.skills.map((s) => s.surface_form)).toEqual(['C#', 'Go', 'Rust', 'Python']);
  });

  it('F: a ref to a NONEXISTENT block id is rejected', async () => {
    const { svc } = makeService(
      ok({
        identity: { first_name: 'Sarah', source_refs: ['B999'] }, // no such block
        skills: [],
        work_history: [],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.proposal.first_name).toBeUndefined();
    expect(out.proposal.rejected_count).toBe(1);
    expect(out.status).toBe('partial');
  });

  it('G: a ref pointing to the WRONG content is rejected', async () => {
    const { svc } = makeService(
      ok({
        // 'Sarah' is not in B002 (the Austin line) → unsupported → rejected.
        identity: { first_name: 'Sarah', source_refs: ['B002'] },
        skills: [],
        work_history: [],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.proposal.first_name).toBeUndefined();
    expect(out.proposal.rejected_count).toBe(1);
  });

  it('H: an unsupported (hallucinated) skill is rejected', async () => {
    const { svc } = makeService(
      ok({
        // 'Kubernetes' is absent from B003 → not supported → rejected.
        skills: [{ surface_form: 'Kubernetes', source_refs: ['B003'] }],
        work_history: [],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.proposal.skills).toEqual([]);
    expect(out.proposal.rejected_count).toBe(1);
  });

  it('I: one invalid fact does NOT erase unrelated valid facts (§14)', async () => {
    const { svc } = makeService(
      ok({
        identity: { first_name: 'Sarah', last_name: 'Nolan', source_refs: ['B001'] },
        skills: [
          { surface_form: 'C#', source_refs: ['B003'] }, // valid
          { surface_form: 'Kubernetes', source_refs: ['B003'] }, // invalid
        ],
        work_history: [
          { employer_name: 'Ghost Corp', role_title: 'Wizard', source_refs: ['B999'] }, // invalid ref
          { employer_name: 'Northstar Systems', role_title: 'Cloud Engineer', source_refs: ['B004'] }, // valid
        ],
      }),
    );
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.proposal.first_name).toBe('Sarah');
    expect(out.proposal.skills.map((s) => s.surface_form)).toEqual(['C#']);
    expect(out.proposal.work_history.map((w) => w.employer_name)).toEqual(['Northstar Systems']);
    expect(out.proposal.rejected_count).toBe(2); // Kubernetes + Ghost Corp
    expect(out.status).toBe('partial');
  });

  it('J: provider TRUNCATION → explicit provider_truncated (never a masked empty)', async () => {
    const { svc } = makeService({ kind: 'retryable', category: 'truncated' });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.status).toBe('provider_truncated');
    expect(out.proposal.skills).toEqual([]);
    expect(out.proposal.work_history).toEqual([]);
  });

  it('K: malformed/off-schema structured output → invalid_structured_output', async () => {
    const { svc } = makeService({ kind: 'retryable', category: 'malformed_output' });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.status).toBe('invalid_structured_output');
  });

  it('provider transport/auth error → provider_failure (no throw)', async () => {
    const { svc } = makeService({ kind: 'terminal', category: 'auth_config' });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: RESUME });
    expect(out.status).toBe('provider_failure');
  });

  it('empty source-map → NO model call, honest partial', async () => {
    const { svc, generateStructured } = makeService(ok({ skills: [], work_history: [] }));
    const out = await svc.extractResumeDraft({
      tenant_id: TENANT,
      source_map: { version: 'resume-source-map/v1', text_hash: 'h', blocks: [] },
    });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(out.status).toBe('partial');
    expect(out.proposal.skills).toEqual([]);
  });
});

// Full-profile EDIT (unchanged behaviour) — replace-set of declared
// work-history. The ctor gains the structured-generation port (4th arg); this
// path is model-independent and never invokes it.
describe('replaceDeclaredWorkHistory — replace-set mapping + delegation', () => {
  const TALENT = '01900000-0000-7000-8000-0000000000aa';

  function makeEditService(): {
    svc: TalentExtractionService;
    replaceWorkHistoryForTalent: ReturnType<typeof vi.fn>;
  } {
    const replaceWorkHistoryForTalent = vi.fn().mockResolvedValue(['wh-a', 'wh-b']);
    const svc = new TalentExtractionService(
      {} as never,
      { replaceWorkHistoryForTalent } as never,
      {} as never,
      {} as never,
    );
    return { svc, replaceWorkHistoryForTalent };
  }

  it('maps valid rows, drops rows missing employer/role, parses dates, tags source=resume', async () => {
    const { svc, replaceWorkHistoryForTalent } = makeEditService();
    await svc.replaceDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [
        { employer_name: 'Northstar', role_title: 'Cloud Engineer', start_date: '2022-01-01', end_date: 'present' },
        { employer_name: '   ', role_title: 'No Employer' },
        { employer_name: 'Acme', role_title: '  ' },
      ],
    });
    expect(replaceWorkHistoryForTalent).toHaveBeenCalledOnce();
    const arg = replaceWorkHistoryForTalent.mock.calls[0][0];
    expect(arg.entries).toHaveLength(1);
    const [row] = arg.entries;
    expect(row.employer_name).toBe('Northstar');
    expect(row.source).toBe('resume');
    expect(row.start_date).toBeInstanceOf(Date);
    expect(row.end_date).toBeUndefined();
  });

  it('an empty set clears the declared work-history (replace with [])', async () => {
    const { svc, replaceWorkHistoryForTalent } = makeEditService();
    await svc.replaceDeclaredWorkHistory({ talent_id: TALENT, tenant_id: TENANT, entries: [] });
    expect(replaceWorkHistoryForTalent).toHaveBeenCalledWith({
      tenant_id: TENANT,
      talent_id: TALENT,
      entries: [],
    });
  });
});
