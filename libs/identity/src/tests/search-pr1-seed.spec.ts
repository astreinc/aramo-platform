import { describe, expect, it } from 'vitest';

import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Search PR-1 — scope-catalog parity (unit level). Lead rulings R1/R2:
//   - talent:search is REUSED (already in the catalog from the A1a audit).
//   - 3 NEW scopes seeded: company:search / requisition:search / contact:search.
//   - SEED_SCOPE_KEYS 67 → 70.
//
// The RoleScope grant count (+28 @ 0x800+, per-entity :read-holder parity)
// is asserted by the integration seed test (identity.integration.spec.ts,
// ARAMO_RUN_INTEGRATION=1 gated): 362 → 390.

describe('Search PR-1 — scope catalog parity', () => {
  it('SEED_SCOPE_KEYS has 75 keys (73 + 2 Job-Module financials)', () => {
    // Search PR-1 took 67→70 (company/requisition/contact :search); the Tasks
    // backend appended task:read + task:write (70→72); Company-Fields v1.1
    // appended company:read_commercial (72→73); the Job-Module appended
    // requisition:view:financials + requisition:edit:financials (73→75).
    expect(SEED_SCOPE_KEYS).toHaveLength(75);
  });

  it('the 3 NEW per-entity search scopes are in the catalog', () => {
    expect(SEED_SCOPE_KEYS).toContain('company:search');
    expect(SEED_SCOPE_KEYS).toContain('requisition:search');
    expect(SEED_SCOPE_KEYS).toContain('contact:search');
  });

  it('talent:search is REUSED (present from the A1a audit, not re-added)', () => {
    const occurrences = SEED_SCOPE_KEYS.filter((k) => k === 'talent:search');
    expect(occurrences).toHaveLength(1);
  });

  it('all 4 search scope keys match the locked SCOPE_KEY_FORMAT', () => {
    for (const key of [
      'talent:search',
      'company:search',
      'requisition:search',
      'contact:search',
    ]) {
      expect(SCOPE_KEY_FORMAT.test(key), `format ${key}`).toBe(true);
    }
  });
});
