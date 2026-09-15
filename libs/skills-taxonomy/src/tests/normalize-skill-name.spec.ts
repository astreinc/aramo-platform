import { describe, expect, it } from 'vitest';

import { normalizeSkillName } from '../lib/normalize-skill-name.js';

// SKILL-TAX-1A normalize boundary. normalizeSkillName is the load-bearing
// canonical lookup key. It MIRRORS the legacy normalizeSkillSurfaceForm
// algorithm (trim -> lowercase -> collapse internal whitespace) at
// libs/talent-extraction/src/lib/skill-id.ts:21-23 so 1C canonicalization
// resolves stored surface forms onto the same key — but is defined
// INDEPENDENTLY and is intentionally NOT code-coupled to it (the legacy
// deriveSkillId / normalizeSkillSurfaceForm pair is a DO-NOT-TOUCH invariant,
// and this lib must not drag the extraction module graph into its tests).
//
// The algorithm is pinned here by exhaustive fixtures: each case encodes the
// exact trim/lowercase/collapse contract, so any drift in normalizeSkillName is
// caught without importing the legacy function.
describe('normalizeSkillName', () => {
  const cases: Array<[string, string]> = [
    ['Kubernetes', 'kubernetes'],
    ['kubernetes', 'kubernetes'],
    ['KUBERNETES', 'kubernetes'],
    ['  Kubernetes ', 'kubernetes'],
    ['K8s', 'k8s'],
    ['Spring   Boot', 'spring boot'],
    ['  MULTI   word  SKILL ', 'multi word skill'],
    ['PostgreSQL', 'postgresql'],
    ['JavaScript', 'javascript'],
    ['C++', 'c++'],
    ['.NET', '.net'],
    ['Node.js', 'node.js'],
    ['\tGo\n', 'go'],
  ];

  it.each(cases)('normalizes %j -> %j (trim + lowercase + collapse whitespace)', (input, expected) => {
    expect(normalizeSkillName(input)).toBe(expected);
  });

  it('is idempotent — normalizing an already-normalized key is a no-op', () => {
    for (const [, expected] of cases) {
      expect(normalizeSkillName(expected)).toBe(expected);
    }
  });
});
