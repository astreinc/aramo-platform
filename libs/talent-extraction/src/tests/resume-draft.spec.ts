import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// Add-Talent governed-LLM DRAFT extraction (LOCKED) — the pre-create, no-persist
// intake proposal. These prove the constrained-to-source guardrails (§8/§12) +
// the failure behavior (§14/§15) against a MOCKED generateDraft completion (the
// established talent-extraction test pattern — no live model).

const TENANT = '01900000-0000-7000-8000-000000000001';

// A résumé source the excerpts must be verbatim-present in.
const SOURCE =
  'Sarah Nolan\n' +
  'Cloud Engineer — Austin, TX\n' +
  'Skills: C#, ASP.NET Core, Azure SQL\n' +
  'Experience: Northstar Systems';

function makeService(completion: string): {
  svc: TalentExtractionService;
  generateDraft: ReturnType<typeof vi.fn>;
} {
  const generateDraft = vi.fn().mockResolvedValue({
    completion,
    model_used: 'claude-sonnet-4-6',
    audit_record_id: 'aud-1',
  });
  const svc = new TalentExtractionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { generateDraft } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );
  return { svc, generateDraft };
}

describe('extractResumeDraft — grounding, dedupe, failure', () => {
  it('empty source → NO model call, empty proposal', async () => {
    const { svc, generateDraft } = makeService('{}');
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: '' });
    expect(generateDraft).not.toHaveBeenCalled();
    expect(out).toEqual({ skills: [], work_history: [], rejected_count: 0 });
  });

  it('grounded skills kept, hallucinated skill REJECTED, duplicates collapsed (§12)', async () => {
    // 'Kubernetes' is NOT in the source but rides a real excerpt — must be
    // rejected (the surface_form itself must appear in the résumé). 'C#'
    // appears twice — collapses to one.
    const completion = JSON.stringify({
      skills: [
        { surface_form: 'C#', source_excerpt: 'Skills: C#, ASP.NET Core' },
        { surface_form: 'C#', source_excerpt: 'Skills: C#' },
        { surface_form: 'ASP.NET Core', source_excerpt: 'C#, ASP.NET Core' },
        { surface_form: 'Kubernetes', source_excerpt: 'Skills: C#, ASP.NET Core' },
      ],
    });
    const { svc } = makeService(completion);
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out.skills).toEqual(['C#', 'ASP.NET Core']);
    expect(out.rejected_count).toBe(1); // Kubernetes
  });

  it('identity kept when grounded; a fabricated surname is dropped (§9)', async () => {
    const completion = JSON.stringify({
      identity: { first_name: 'Sarah', last_name: 'Fabricated', source_excerpt: 'Sarah Nolan' },
      skills: [],
    });
    const { svc } = makeService(completion);
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out.first_name).toBe('Sarah');
    expect(out.last_name).toBeUndefined(); // 'Fabricated' not in source → dropped
  });

  it('location kept only when grounded (§11)', async () => {
    const completion = JSON.stringify({
      location: { city: 'Austin', state: 'TX', source_excerpt: 'Austin, TX' },
      skills: [],
    });
    const { svc } = makeService(completion);
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out.city).toBe('Austin');
    expect(out.state).toBe('TX');
  });

  it('a whole group with an UNGROUNDED excerpt is rejected', async () => {
    const completion = JSON.stringify({
      identity: { first_name: 'Someone', last_name: 'Else', source_excerpt: 'not in the resume at all' },
      skills: [],
    });
    const { svc } = makeService(completion);
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out.first_name).toBeUndefined();
    expect(out.last_name).toBeUndefined();
    expect(out.rejected_count).toBe(1);
  });

  it('malformed model output → empty proposal, NEVER throws (§14)', async () => {
    const { svc } = makeService('this is not json at all');
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out).toEqual({ skills: [], work_history: [], rejected_count: 0 });
  });

  it('work_history kept when grounded; an ungrounded entry is rejected', async () => {
    const completion = JSON.stringify({
      skills: [],
      work_history: [
        {
          employer_name: 'Northstar Systems',
          role_title: 'Cloud Engineer',
          source_excerpt: 'Experience: Northstar Systems',
        },
        {
          employer_name: 'Ghost Corp',
          role_title: 'Wizard',
          source_excerpt: 'this text is not in the resume',
        },
      ],
    });
    const { svc } = makeService(completion);
    const out = await svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE });
    expect(out.work_history).toEqual([
      { employer_name: 'Northstar Systems', role_title: 'Cloud Engineer' },
    ]);
    expect(out.rejected_count).toBe(1); // Ghost Corp — excerpt not in source
  });

  it('provider error propagates (caller maps to non-blocking empty+retry, §15)', async () => {
    const generateDraft = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const svc = new TalentExtractionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { generateDraft } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    await expect(
      svc.extractResumeDraft({ tenant_id: TENANT, resume_text: SOURCE }),
    ).rejects.toThrow('provider unavailable');
  });
});

// Full-profile EDIT (LOCKED scope expansion) — replace-set of declared
// work-history. Proves the mapping (employer/role required; free-text dates
// parsed; 'present' → ongoing) + the delegation to the repository's atomic
// replace. No model call — this path is model-independent.
describe('replaceDeclaredWorkHistory — replace-set mapping + delegation', () => {
  const TALENT = '01900000-0000-7000-8000-0000000000aa';

  function makeService(): {
    svc: TalentExtractionService;
    replaceWorkHistoryForTalent: ReturnType<typeof vi.fn>;
  } {
    const replaceWorkHistoryForTalent = vi.fn().mockResolvedValue(['wh-a', 'wh-b']);
    const svc = new TalentExtractionService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { replaceWorkHistoryForTalent } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    return { svc, replaceWorkHistoryForTalent };
  }

  it('maps valid rows, drops rows missing employer/role, parses dates, tags source=resume', async () => {
    const { svc, replaceWorkHistoryForTalent } = makeService();
    await svc.replaceDeclaredWorkHistory({
      talent_id: TALENT,
      tenant_id: TENANT,
      entries: [
        { employer_name: 'Northstar', role_title: 'Cloud Engineer', start_date: '2022-01-01', end_date: 'present' },
        { employer_name: '   ', role_title: 'No Employer' }, // dropped (empty employer)
        { employer_name: 'Acme', role_title: '  ' }, // dropped (empty role)
      ],
    });
    expect(replaceWorkHistoryForTalent).toHaveBeenCalledOnce();
    const arg = replaceWorkHistoryForTalent.mock.calls[0][0];
    expect(arg.tenant_id).toBe(TENANT);
    expect(arg.talent_id).toBe(TALENT);
    expect(arg.entries).toHaveLength(1);
    const [row] = arg.entries;
    expect(row.employer_name).toBe('Northstar');
    expect(row.role_title).toBe('Cloud Engineer');
    expect(row.source).toBe('resume');
    expect(row.start_date).toBeInstanceOf(Date);
    // 'present' is not a calendar date → no end_date (ongoing).
    expect(row.end_date).toBeUndefined();
    expect(typeof row.id).toBe('string');
  });

  it('an empty set clears the declared work-history (replace with [])', async () => {
    const { svc, replaceWorkHistoryForTalent } = makeService();
    await svc.replaceDeclaredWorkHistory({ talent_id: TALENT, tenant_id: TENANT, entries: [] });
    expect(replaceWorkHistoryForTalent).toHaveBeenCalledWith({
      tenant_id: TENANT,
      talent_id: TALENT,
      entries: [],
    });
  });
});
