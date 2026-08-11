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

  it('SEED_SCOPE_KEYS is 115 (107 + 4 Track4/T4-D assignment + 2 Track5/T5-P1 assignment:commercials + 2 Track8/T8-P2 requisition:import)', () => {
    expect(SEED_SCOPE_KEYS).toHaveLength(115);
  });
});
