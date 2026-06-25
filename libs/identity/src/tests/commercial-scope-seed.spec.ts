import { describe, expect, it } from 'vitest';

import { SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Company-Fields v1.1 — scope-catalog parity (unit tier). The authoritative
// GRANT-TABLE proof (which roles hold company:read_commercial) is the
// real-DB resolve in identity.integration.spec.ts ("Company-Fields v1.1 —
// grant-table"); this unit spec pins the catalog entry exists exactly once.
describe('Company-Fields v1.1 — company:read_commercial catalog parity', () => {
  it('SEED_SCOPE_KEYS contains company:read_commercial exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('company:read_commercial');
    expect(
      SEED_SCOPE_KEYS.filter((k) => k === 'company:read_commercial'),
    ).toHaveLength(1);
  });

  it('SEED_SCOPE_KEYS is 86 (85 + 1 Domain-Enforcement P2b tenant:admin:domain scope)', () => {
    expect(SEED_SCOPE_KEYS).toHaveLength(86);
  });
});
