import { describe, expect, it, vi } from 'vitest';
import { buildResumeSourceMap } from '@aramo/resume-parse';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { ResumeExtractionOrchestrator } from '../lib/resume-extraction/resume-extraction.orchestrator.js';

import { RESUME_LAYOUTS } from './fixtures/resume-layouts.js';

// ATS-QA-1 I-3 — deterministic mapping corpus (no live model). Each anonymised
// layout runs the REAL pipeline: résumé text → buildResumeSourceMap → (mocked
// structured-generation port returns the fixture's v4 model output) → grounding
// in TalentExtractionService.extractResumeDraft → orchestrator mapping. Pins:
// listed skills (top-level, with refs), the key_skills display union (A2), the
// kept work-history entries (incl. abbreviated titles), dates as stated, and
// the draft warning for rejected entries.

const TENANT = '01900000-0000-7000-8000-000000000001';

function pipelineFor(text: string, model: Record<string, unknown>) {
  const generateStructured = vi.fn().mockResolvedValue({
    kind: 'ok',
    parsed: model,
    transport: { model_used: 'm', input_tokens: 1, output_tokens: 1, provider_request_id: 'r' },
  });
  const extraction = new TalentExtractionService(
    { generateDraft: vi.fn() } as never,
    {} as never,
    { generateStructured, providerKey: () => 'anthropic' } as never,
  );
  const orchestrator = new ResumeExtractionOrchestrator(
    { authorize: async () => ({ storage_key: 'tenant/k' }) } as never,
    { extractTextFromStorageKey: async () => text } as never,
    extraction,
  );
  return { orchestrator, generateStructured };
}

describe('ATS-QA-1 I-3 — résumé layout mapping corpus (5 anonymised layouts)', () => {
  it('the corpus holds exactly 5 layouts', () => {
    expect(RESUME_LAYOUTS).toHaveLength(5);
  });

  for (const layout of RESUME_LAYOUTS) {
    it(`maps: ${layout.name}`, async () => {
      const text = layout.lines.join('\n');
      const map = buildResumeSourceMap(text);
      const width = Math.max(3, String(map.blocks.length).length);
      const b = (line: number): string => `B${String(line).padStart(width, '0')}`;
      // Sanity: the fixture's line numbering is the source-map numbering.
      expect(map.blocks[0]?.block_id).toBe(b(1));
      expect(map.blocks).toHaveLength(layout.lines.length);

      const { orchestrator, generateStructured } = pipelineFor(text, layout.model(b));
      const res = await orchestrator.extractResume(
        { kind: 'CREATE_DRAFT_UPLOAD', storage_key: 'tenant/k' },
        { tenant_id: TENANT, requestId: 'req' },
      );

      // One governed call, with the v4 prompt asking for top-level skills from
      // any section and stating the accepted date formats.
      expect(generateStructured).toHaveBeenCalledTimes(1);
      const call = generateStructured.mock.calls[0]?.[0] as { system: string };
      expect(call.system).toContain('Technical Skills');
      expect(call.system).toContain('Summary');
      expect(call.system).toContain('"YYYY-MM"');

      // Explicitly listed = top-level skills with refs.
      expect((res.skills ?? []).map((s) => s.surface_form)).toEqual(layout.expect.listedSkills);
      for (const s of res.skills ?? []) expect(s.source_refs.length).toBeGreaterThan(0);
      // key_skills = de-duplicated display union (listed ∪ evidenced).
      expect(res.prefill.key_skills).toBe(layout.expect.keySkills);
      // key_skills is display text only — no years / proficiency manufactured.
      expect(res.prefill.key_skills).not.toMatch(/\byears?\b|\bexpert\b|\bproficien/i);

      // Work history kept, in order, dates exactly as stated.
      expect(
        (res.work_history ?? []).map((w) => ({
          employer: w.employer_name,
          title: w.role_title,
          ...(w.start_date !== undefined ? { start: w.start_date } : {}),
          ...(w.end_date !== undefined ? { end: w.end_date } : {}),
        })),
      ).toEqual(layout.expect.roles);
      expect(res.education ?? []).toHaveLength(layout.expect.education);

      if (layout.expect.warning !== undefined) {
        expect(res.warning).toMatch(layout.expect.warning);
        expect(res.extraction_status).toBe('partial');
      } else {
        expect(res.warning).toBeUndefined();
      }
    });
  }
});
