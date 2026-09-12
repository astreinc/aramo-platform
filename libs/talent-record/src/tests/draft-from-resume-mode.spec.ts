import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';

// Add-Talent draft-from-resume — MODE IS EXCLUSIVE (LOCKED). The tenant setting
// selects the SOLE extractor server-side; the other extractor is never invoked.
// LLM failure → empty prefill + warning + retry, NEVER a deterministic fallback.

const TENANT = '01900000-0000-7000-8000-000000000001';
const AUTH = { sub: 'me', tenant_id: TENANT, scopes: ['talent:read'] } as unknown as AuthContextType;

function makeController(opts: {
  mode: 'governed_llm' | 'deterministic';
  text?: string | null;
  proposal?: unknown;
  proposalThrows?: boolean;
  deterministicResult?: unknown;
}) {
  const tenantSetting = { get: vi.fn().mockResolvedValue(opts.mode) };
  const extractResumeDraft = opts.proposalThrows
    ? vi.fn().mockRejectedValue(new Error('provider unavailable'))
    : vi.fn().mockResolvedValue(opts.proposal ?? { skills: [], work_history: [], rejected_count: 0 });
  const talentExtraction = { extractResumeDraft };
  const parseFromStorageKey = vi
    .fn()
    .mockResolvedValue(opts.deterministicResult ?? { prefill: {}, parse_status: 'partial' });
  const extractTextFromStorageKey = vi.fn().mockResolvedValue(opts.text ?? null);
  const resumeParser = { parseFromStorageKey, extractTextFromStorageKey };
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
    tenantSetting as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    talentExtraction as any,
  );
  return { ctl, tenantSetting, extractResumeDraft, parseFromStorageKey, extractTextFromStorageKey };
}

describe('draft-from-resume — exclusive mode resolver', () => {
  it('empty storage_key → VALIDATION_ERROR', async () => {
    const { ctl } = makeController({ mode: 'deterministic' });
    await expect(
      ctl.draftFromResume(AUTH, { storage_key: '' }, 'rq-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('governed_llm → LLM is the SOLE extractor (deterministic parser NOT called)', async () => {
    const { ctl, extractResumeDraft, parseFromStorageKey, extractTextFromStorageKey } = makeController({
      mode: 'governed_llm',
      text: 'Sarah Nolan — Cloud Engineer, Austin TX. Skills: C#, Azure SQL',
      proposal: {
        first_name: 'Sarah',
        last_name: 'Nolan',
        skills: ['C#', 'Azure SQL'],
        work_history: [{ employer_name: 'Northstar', role_title: 'Engineer' }],
        rejected_count: 0,
      },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: 'k' }, 'rq-1');
    expect(res.mode).toBe('governed_llm');
    expect(res.prefill.first_name).toBe('Sarah');
    expect(res.prefill.key_skills).toBe('C#, Azure SQL');
    // Work-history rides the response for the review card (declared, editable).
    expect(res.work_history).toEqual([{ employer_name: 'Northstar', role_title: 'Engineer' }]);
    // Email/phone are NEVER LLM-proposed (redacted; held for the amendment).
    expect(res.prefill.email1).toBeUndefined();
    expect(res.prefill.phone_cell).toBeUndefined();
    expect(extractTextFromStorageKey).toHaveBeenCalledOnce();
    expect(extractResumeDraft).toHaveBeenCalledOnce();
    expect(parseFromStorageKey).not.toHaveBeenCalled();
  });

  it('deterministic → parser is the SOLE extractor (NO LLM call)', async () => {
    const { ctl, extractResumeDraft, parseFromStorageKey, extractTextFromStorageKey } = makeController({
      mode: 'deterministic',
      deterministicResult: { prefill: { first_name: 'Deter', email1: 'd@x.com' }, parse_status: 'parsed' },
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: 'k' }, 'rq-1');
    expect(res.mode).toBe('deterministic');
    expect(res.prefill.first_name).toBe('Deter');
    expect(parseFromStorageKey).toHaveBeenCalledOnce();
    expect(extractResumeDraft).not.toHaveBeenCalled();
    expect(extractTextFromStorageKey).not.toHaveBeenCalled();
  });

  it('governed_llm + unreadable résumé (null text) → empty prefill + warning, LLM NOT called', async () => {
    const { ctl, extractResumeDraft } = makeController({ mode: 'governed_llm', text: null });
    const res = await ctl.draftFromResume(AUTH, { storage_key: 'k' }, 'rq-1');
    expect(res.mode).toBe('governed_llm');
    expect(res.prefill).toEqual({});
    expect(res.parse_status).toBe('failed');
    expect(res.warning).toBeDefined();
    expect(extractResumeDraft).not.toHaveBeenCalled();
  });

  it('governed_llm + LLM error → empty prefill + warning, NO deterministic fallback (§15)', async () => {
    const { ctl, parseFromStorageKey } = makeController({
      mode: 'governed_llm',
      text: 'some resume text',
      proposalThrows: true,
    });
    const res = await ctl.draftFromResume(AUTH, { storage_key: 'k' }, 'rq-1');
    expect(res.mode).toBe('governed_llm');
    expect(res.prefill).toEqual({});
    expect(res.warning).toBeDefined();
    // The tenant chose governed_llm — we do NOT silently run the parser.
    expect(parseFromStorageKey).not.toHaveBeenCalled();
  });
});
