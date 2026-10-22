import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';
import type { ResumeSourceMap } from '../lib/dto/extraction.dto.js';

// ATS-QA-1 I-3 — résumé-draft v4: the prompt asks for top-level explicitly
// stated skills from ANY section and states the accepted date formats (HF1 §8);
// a work-history title grounds when it is a normalised substring of the cited
// blocks (abbreviations); rejected entries are REPORTED; year-only END dates
// persist on the end edge (December), not January 1.

const TENANT = '01900000-0000-7000-8000-000000000001';

function mapOf(blocks: Array<{ id: string; text: string }>): ResumeSourceMap {
  let cursor = 0;
  const mapped = blocks.map((b) => {
    const char_start = cursor;
    const char_end = char_start + b.text.length;
    cursor = char_end + 1;
    return { block_id: b.id, text: b.text, char_start, char_end };
  });
  return { version: 'resume-source-map/v1', text_hash: 'h', blocks: mapped };
}

function svcWith(parsed: Record<string, unknown>) {
  const generateStructured = vi.fn().mockResolvedValue({
    kind: 'ok',
    parsed: { skills: [], work_history: [], education: [], certifications: [], ...parsed },
    transport: { model_used: 'm', input_tokens: 1, output_tokens: 1, provider_request_id: 'r' },
  });
  const svc = new TalentExtractionService(
    { generateDraft: vi.fn() } as never,
    {} as never,
    {} as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  return { svc, generateStructured };
}

describe('resume-draft v4 — prompt', () => {
  it('asks for top-level skills from any section, with refs, and states the date formats', async () => {
    const { svc, generateStructured } = svcWith({});
    await svc.extractResumeDraft({ tenant_id: TENANT, source_map: mapOf([{ id: 'B001', text: 'x' }]) });
    const system = (generateStructured.mock.calls[0]?.[0] as { system: string }).system;
    expect(system).toContain('Top-level "skills"');
    expect(system).toContain('Technical Skills');
    expect(system).toContain('Technical or Professional');
    expect(system).toContain('the text of a role');
    expect(system).toContain('"source_refs" naming EVERY block');
    // HF1 §8 — explicit facts only, no expansion to implied technologies.
    expect(system).toContain('expand one skill into');
    expect(system).toContain('never add one it does not');
    for (const f of ['"YYYY-MM-DD"', '"YYYY-MM"', '"MM/YYYY"', '"Mon YYYY"', '"YYYY"', '"Present"']) {
      expect(system).toContain(f);
    }
    // The schema shape is unchanged (schema name stays v3).
    expect((generateStructured.mock.calls[0]?.[0] as { schema_name: string }).schema_name).toBe(
      'resume-draft-extraction/v3',
    );
  });
});

describe('resume-draft v4 — work-history title grounding', () => {
  const blocks = [
    { id: 'B001', text: 'Northwind Traders — Sr. Software Engr. (2021 - Present)' },
    { id: 'B002', text: 'Contoso Retail — Project Mgr, R&D (2018 - 2021)' },
    { id: 'B003', text: 'Kestrel Media — Head of Platform (2014 - 2018)' },
  ];
  const wh = (employer_name: string, role_title: string, refs: string[]) => ({
    employer_name,
    role_title,
    source_refs: refs,
  });

  it('keeps abbreviated titles (normalised substring), rejects and REPORTS the rest', async () => {
    const { svc } = svcWith({
      work_history: [
        wh('Northwind Traders', 'Senior Software Engineer', ['B001']),
        wh('Contoso Retail', 'Project Manager, R and D', ['B002']),
        wh('Kestrel Media', 'Chief Technology Officer', ['B003']),
        wh('Fabrikam Studios', 'Engineer', ['B003']),
        wh('Kestrel Media', '', ['B003']),
      ],
    });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: mapOf(blocks) });
    expect(out.proposal.work_history.map((w) => w.role_title)).toEqual([
      'Senior Software Engineer',
      'Project Manager, R and D',
    ]);
    expect(out.proposal.rejected_work_history).toEqual([
      { employer_name: 'Kestrel Media', reason: 'title_not_found' },
      { reason: 'employer_not_found' },
      { employer_name: 'Kestrel Media', reason: 'incomplete_entry' },
    ]);
    expect(out.proposal.rejected_count).toBe(3);
    expect(out.status).toBe('partial');
  });

  it('normalisation matches whole words only — a title is never grounded inside a longer word', async () => {
    const { svc } = svcWith({
      work_history: [wh('Acme', 'Sr Dev', ['B001'])],
    });
    const out = await svc.extractResumeDraft({
      tenant_id: TENANT,
      source_map: mapOf([{ id: 'B001', text: 'Acme — Senior Developmental Editor' }]),
    });
    expect(out.proposal.work_history).toHaveLength(0);
    expect(out.proposal.rejected_work_history).toEqual([
      { employer_name: 'Acme', reason: 'title_not_found' },
    ]);
  });

  it('a nonexistent ref never grounds a title, abbreviated or not', async () => {
    const { svc } = svcWith({
      work_history: [wh('Northwind Traders', 'Senior Software Engineer', ['B001', 'B999'])],
    });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: mapOf(blocks) });
    expect(out.proposal.work_history).toHaveLength(0);
  });

  it('a strictly grounded title is unaffected and no rejection is reported', async () => {
    const { svc } = svcWith({ work_history: [wh('Kestrel Media', 'Head of Platform', ['B003'])] });
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, source_map: mapOf(blocks) });
    expect(out.proposal.work_history).toHaveLength(1);
    expect(out.proposal.rejected_work_history).toBeUndefined();
  });
});

describe('persistDeclaredWorkHistory — year-only END dates use the end edge', () => {
  it('start "2016" → 2016-01-01; end "2019" → 2019-12-01; month precision unchanged; Present → no end', async () => {
    const createTalentWorkHistoryEntry = vi.fn().mockResolvedValue(undefined);
    // Any other evidence write (derived snapshot, …) is a no-op here.
    const evidence = new Proxy(
      { createTalentWorkHistoryEntry } as Record<string, unknown>,
      { get: (t, k: string) => t[k] ?? vi.fn().mockResolvedValue(undefined) },
    );
    const svc = new TalentExtractionService(
      { generateDraft: vi.fn() } as never,
      evidence as never,
      {} as never,
      { generateStructured: vi.fn() } as never,
    );
    await svc.persistDeclaredWorkHistory({
      talent_id: 't',
      tenant_id: TENANT,
      entries: [
        { employer_name: 'Acme', role_title: 'Analyst', start_date: '2016', end_date: '2019', source_refs: [] },
        { employer_name: 'Bolt', role_title: 'Lead', start_date: 'Mar 2019', end_date: 'Feb 2021', source_refs: [] },
        { employer_name: 'Crest', role_title: 'Head', start_date: '2021', end_date: 'Present', source_refs: [] },
      ],
    });
    const rows = createTalentWorkHistoryEntry.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
    expect(rows.map((r) => [iso(r['start_date']), iso(r['end_date'])])).toEqual([
      ['2016-01-01', '2019-12-01'],
      ['2019-03-01', '2021-02-01'],
      ['2021-01-01', undefined],
    ]);
  });
});
