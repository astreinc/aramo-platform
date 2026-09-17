import { describe, expect, it, vi } from 'vitest';

import { CanonicalMatchShadowComparator } from '../examinations/canonical-match-shadow.comparator.js';

// SKILL-TAX-1E — the comparator's two hard contracts, WITHOUT a DB:
//   • DARK: disabled flag → zero reads, zero writes, returns 0.
//   • BEST-EFFORT / ISOLATED: any downstream throw is swallowed (the shadow can
//     never fail the authoritative examine, whose result is already returned).

const TENANT = '10000000-0000-7000-8000-000000000001';
const EXAM = '20000000-0000-7000-8000-000000000001';
const TALENT = '30000000-0000-7000-8000-000000000001';
const GP = '40000000-0000-7000-8000-000000000001';
const REQ = '50000000-0000-7000-8000-000000000001';
const K8S = '60000000-0000-7000-8000-000000000001';

function make(parts: {
  enabled?: boolean;
  requirements?: unknown[];
  talentSkills?: unknown[];
  persist?: ReturnType<typeof vi.fn>;
} = {}) {
  const config = { isEnabled: () => parts.enabled ?? true } as never;
  const listForGoldenProfile = vi.fn().mockResolvedValue(parts.requirements ?? []);
  const requirements = { listForGoldenProfile } as never;
  const listCanonicalSkillsForTalent = vi.fn().mockResolvedValue(parts.talentSkills ?? []);
  const talentCanonical = { listCanonicalSkillsForTalent } as never;
  const persistObservations =
    parts.persist ?? vi.fn().mockResolvedValue(1);
  const shadowRepo = { persistObservations } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
  const comparator = new CanonicalMatchShadowComparator(
    config,
    requirements,
    talentCanonical,
    shadowRepo,
    logger,
  );
  return { comparator, listForGoldenProfile, listCanonicalSkillsForTalent, persistObservations, logger };
}

const ARGS = {
  tenant_id: TENANT,
  examination_id: EXAM,
  talent_id: TALENT,
  golden_profile_id: GP,
  requisition_id: REQ,
  golden_critical_skill_names: ['Kubernetes'] as string[],
};

describe('CanonicalMatchShadowComparator — DARK', () => {
  it('disabled flag → no reads, no writes, returns 0', async () => {
    const { comparator, listForGoldenProfile, listCanonicalSkillsForTalent, persistObservations } =
      make({ enabled: false });
    await expect(comparator.observe(ARGS)).resolves.toBe(0);
    expect(listForGoldenProfile).not.toHaveBeenCalled();
    expect(listCanonicalSkillsForTalent).not.toHaveBeenCalled();
    expect(persistObservations).not.toHaveBeenCalled();
  });
});

describe('CanonicalMatchShadowComparator — best-effort isolation', () => {
  it('a persist rejection is swallowed (returns 0, logs warn — examine unaffected)', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('db exploded'));
    const { comparator, logger } = make({
      enabled: true,
      requirements: [
        { requirement_type: 'critical', raw_surface_form: 'Kubernetes', canonical_skill_id: K8S, canonicalization_method: 'EXACT_CANONICAL' },
      ],
      talentSkills: [
        { surface_form: 'Kubernetes', canonical_skill_id: K8S, canonicalization_status: 'RESOLVED', canonicalization_method: 'EXACT_CANONICAL' },
      ],
      persist,
    });
    await expect(comparator.observe(ARGS)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canonical_match_shadow_failed' }),
    );
  });

  it('a read rejection is swallowed too', async () => {
    const { comparator } = make({ enabled: true });
    // force listForGoldenProfile to throw
    (comparator as unknown as { requirements: { listForGoldenProfile: ReturnType<typeof vi.fn> } }).requirements = {
      listForGoldenProfile: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(comparator.observe(ARGS)).resolves.toBe(0);
  });
});

describe('CanonicalMatchShadowComparator — happy path (enabled)', () => {
  it('filters to critical, computes observations, persists, returns the count', async () => {
    const { comparator, listForGoldenProfile, persistObservations } = make({
      enabled: true,
      requirements: [
        { requirement_type: 'critical', raw_surface_form: 'Kubernetes', canonical_skill_id: K8S, canonicalization_method: 'EXACT_CANONICAL' },
        { requirement_type: 'required', raw_surface_form: 'Java', canonical_skill_id: null, canonicalization_method: null },
      ],
      talentSkills: [
        { surface_form: 'Kubernetes', canonical_skill_id: K8S, canonicalization_status: 'RESOLVED', canonicalization_method: 'EXACT_CANONICAL' },
      ],
    });
    const n = await comparator.observe(ARGS);
    expect(n).toBe(1);
    expect(listForGoldenProfile).toHaveBeenCalledWith(TENANT, GP);
    const persistArg = persistObservations.mock.calls[0][0];
    // Only the CRITICAL Kubernetes requirement is observed (required Java ignored).
    expect(persistArg.observations).toHaveLength(1);
    expect(persistArg.observations[0].match_class).toBe('CANONICAL_EXACT');
    expect(persistArg.examination_id).toBe(EXAM);
  });
});
