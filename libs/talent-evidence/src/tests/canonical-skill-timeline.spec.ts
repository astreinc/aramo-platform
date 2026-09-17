import { describe, expect, it } from 'vitest';

import { aggregateCanonicalYears } from '../lib/canonical-skill-timeline.js';

// SKILL-TAX-1G — canonical interval-union aggregation (§19). Proves union
// semantics: adjacent ranges join, overlaps do not double-count, missing bounds
// contribute count but no duration, and canonical skills stay separate.
const K = '11111111-1111-7111-8111-111111111111';
const J = '22222222-2222-7222-8222-222222222222';

describe('aggregateCanonicalYears', () => {
  it('unions adjacent intervals (K8s 2020-2022 + Kubernetes 2022-2025 = 2020-2025)', () => {
    const out = aggregateCanonicalYears([
      { canonicalSkillId: K, usageStart: new Date('2020-01-01'), usageEnd: new Date('2022-01-01') },
      { canonicalSkillId: K, usageStart: new Date('2022-01-01'), usageEnd: new Date('2025-01-01') },
    ]);
    expect(out[K].supported_years).toBe(5);
    expect(out[K].first_used).toBe('2020-01-01');
    expect(out[K].last_used).toBe('2025-01-01');
    expect(out[K].evidence_count).toBe(2);
  });

  it('does not double-count overlapping intervals', () => {
    // 2020-2023 (3y) with a contained 2021-2022 (1y) -> union is still 3y, not 4y.
    const out = aggregateCanonicalYears([
      { canonicalSkillId: K, usageStart: new Date('2020-01-01'), usageEnd: new Date('2023-01-01') },
      { canonicalSkillId: K, usageStart: new Date('2021-01-01'), usageEnd: new Date('2022-01-01') },
    ]);
    expect(out[K].supported_years).toBe(3);
    expect(out[K].evidence_count).toBe(2);
  });

  it('counts a row with missing bounds but adds no duration', () => {
    const out = aggregateCanonicalYears([
      { canonicalSkillId: K, usageStart: new Date('2020-01-01'), usageEnd: new Date('2021-01-01') },
      { canonicalSkillId: K, usageStart: null, usageEnd: null },
    ]);
    expect(out[K].supported_years).toBe(1);
    expect(out[K].evidence_count).toBe(2);
  });

  it('keeps distinct canonical skills separate', () => {
    const out = aggregateCanonicalYears([
      { canonicalSkillId: K, usageStart: new Date('2020-01-01'), usageEnd: new Date('2021-01-01') },
      { canonicalSkillId: J, usageStart: new Date('2015-01-01'), usageEnd: new Date('2018-01-01') },
    ]);
    expect(Object.keys(out).sort()).toEqual([K, J].sort());
    expect(out[J].supported_years).toBe(3);
  });

  it('returns nothing for zero rows', () => {
    expect(aggregateCanonicalYears([])).toEqual({});
  });
});
