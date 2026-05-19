import { describe, expect, it } from 'vitest';

import { ExaminationRepository } from '../lib/examination.repository.js';

// Unit tests for ExaminationRepository. M3 PR-1 §3.3 surface check:
//
//   - The repository exposes exactly the four declared methods.
//   - No analytical-update method is exposed (belt-and-suspenders
//     immutability; the database trigger is the second belt).
//   - why_matched_sentence > 140 chars is rejected at the create
//     boundary (the §3.1 application-layer validation).
//
// Database round-trip behavior (snapshot creation, lifecycle transitions,
// the DB trigger) is exercised by the *.integration.spec.ts files against
// a real Postgres testcontainer under ARAMO_RUN_INTEGRATION=1.
describe('ExaminationRepository — surface', () => {
  // PR-1 surface: { createSnapshot, findById, findByTenantAndTalent,
  // markSuperseded }. PR-6 adds two READ-ONLY, PROJECT-ONLY methods
  // (findByIdSummary, findByIdFull) per directive §4.2 — the typed
  // read-side projection over the existing TalentJobExamination row.
  // No write method added; the closed-surface immutability discipline is
  // preserved (the no-analytical-mutation test below still passes — read
  // projections issue no UPDATE).
  it('exposes exactly the PR-1 + PR-6 surface (4 + 2 methods)', () => {
    const methods = Object.getOwnPropertyNames(ExaminationRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'createSnapshot',
        'findById',
        'findByIdFull',
        'findByIdSummary',
        'findByTenantAndTalent',
        'markSuperseded',
      ].sort(),
    );
  });

  it('exposes no analytical-mutation method (no `update*`, `mutate*`, `setTier*`, `setReasoning*` etc.)', () => {
    const methods = Object.getOwnPropertyNames(ExaminationRepository.prototype);
    const forbiddenPrefixes = ['update', 'mutate', 'setTier', 'setReasoning', 'rewrite', 'overwrite'];
    const offending = methods.filter((m) =>
      forbiddenPrefixes.some((p) => m.toLowerCase().startsWith(p.toLowerCase())),
    );
    expect(offending).toEqual([]);
  });

  it('rejects why_matched_sentence longer than 140 chars at the create boundary (§2.4 / §3.1)', async () => {
    // No DB connection needed — the validation fires synchronously before
    // any Prisma call, throwing rather than reaching the client.
    const repo = new ExaminationRepository(undefined as never);
    const tooLong = 'x'.repeat(141);
    await expect(
      repo.createSnapshot({
        id: '00000000-0000-7000-8000-000000000001',
        tenant_id: '11111111-1111-7111-8111-111111111111',
        talent_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
        golden_profile_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
        trigger: 'initial_match',
        tier: 'ENTRUSTABLE',
        rank_ordinal: 1,
        why_matched_sentence: tooLong,
        match_summary: 'm',
        expanded_reasoning: [],
        skill_match: {},
        experience_match: {},
        constraint_checks: {},
        strengths: [],
        gaps: [],
        risk_flags: [],
        confidence_indicators: {},
        freshness_indicator: {},
        examination_version: 'v1',
        model_version: 'v1',
        taxonomy_version: 'v1',
        computed_at: new Date('2026-05-17T20:00:00Z'),
      }),
    ).rejects.toThrow(/why_matched_sentence exceeds 140/);
  });
});
