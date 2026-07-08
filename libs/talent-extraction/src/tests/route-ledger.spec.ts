import { describe, expect, it, vi } from 'vitest';

import { TalentExtractionService } from '../lib/talent-extraction.service.js';

// TR-4 B2 (§5c/§5d) — the reconcile's idempotence + loud-fail posture, unit-level
// with controllable stubs (no DB). The real ledger behavior is proven in the
// apps/api integration spec; here we prove the CONTROL FLOW: skip-when-present,
// propagate-on-failure, exactly-once-on-retry.

function makeService(opts: {
  skills: Array<{ id: string; surface_form: string; skill_id: string }>;
  work: Array<{
    id: string;
    employer_name: string;
    role_title: string;
    start_date: Date | null;
    end_date: Date | null;
    employment_type: string | null;
  }>;
  record: (input: { assertion_type: string; source_ref: { talent_evidence_id: string } }) => Promise<{
    written: boolean;
    evidence_id?: string;
  }>;
}): { service: TalentExtractionService; record: ReturnType<typeof vi.fn> } {
  const evidence = {
    listSkillEvidenceForLedger: vi.fn().mockResolvedValue(opts.skills),
    listWorkHistoryForLedger: vi.fn().mockResolvedValue(opts.work),
  };
  const record = vi.fn(opts.record);
  const trust = { recordDeclaredClaimIfAbsent: record };
  const aiDraft = { generateDraft: vi.fn() };
  const service = new TalentExtractionService(
    aiDraft as never,
    evidence as never,
    trust as never,
  );
  return { service, record };
}

const SKILLS = [
  { id: 's1', surface_form: 'TypeScript', skill_id: 'k1' },
  { id: 's2', surface_form: 'Go', skill_id: 'k2' },
];

describe('routeDeclaredEvidenceToLedger — idempotence (§5c)', () => {
  it('skips rows whose ledger counterpart already exists (writes zero)', async () => {
    const { service, record } = makeService({
      skills: SKILLS,
      work: [],
      // Existence check → already present for every row.
      record: () => Promise.resolve({ written: false }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 0, work_history_written: 0, skipped: 2 });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('writes only the absent rows', async () => {
    const { service } = makeService({
      skills: SKILLS,
      work: [],
      record: (input) => Promise.resolve({ written: input.source_ref.talent_evidence_id === 's2' }),
    });
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 1, work_history_written: 0, skipped: 1 });
  });
});

describe('routeDeclaredEvidenceToLedger — loud fail then exactly-once on retry (§5d)', () => {
  it('propagates a ledger failure loudly, then the retry completes exactly once', async () => {
    // Track which source_refs have been "written" across runs (a stand-in for the
    // ledger's existence check).
    const written = new Set<string>();
    let failNext = true;

    const record = (input: { source_ref: { talent_evidence_id: string } }): Promise<{ written: boolean }> => {
      const id = input.source_ref.talent_evidence_id;
      if (written.has(id)) return Promise.resolve({ written: false }); // already present
      if (id === 's2' && failNext) {
        return Promise.reject(new Error('ledger down'));
      }
      written.add(id);
      return Promise.resolve({ written: true });
    };

    const evidence = {
      listSkillEvidenceForLedger: vi.fn().mockResolvedValue(SKILLS),
      listWorkHistoryForLedger: vi.fn().mockResolvedValue([]),
    };
    const trust = { recordDeclaredClaimIfAbsent: vi.fn(record) };
    const service = new TalentExtractionService(
      { generateDraft: vi.fn() } as never,
      evidence as never,
      trust as never,
    );

    // Run 1 — s1 writes, s2 throws → the whole call rejects LOUDLY.
    await expect(
      service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' }),
    ).rejects.toThrow(/ledger down/);
    expect(written.has('s1')).toBe(true);
    expect(written.has('s2')).toBe(false);

    // Retry — s1 already present (skip), s2 now writes → exactly once.
    failNext = false;
    const r = await service.routeDeclaredEvidenceToLedger({ tenant_id: 't', talent_id: 'tr' });
    expect(r).toEqual({ skills_written: 1, work_history_written: 0, skipped: 1 });
    expect(written.has('s2')).toBe(true);
    // s1 was written exactly once (run 1), s2 exactly once (retry).
    expect([...written].sort()).toEqual(['s1', 's2']);
  });
});
