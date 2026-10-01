import { describe, expect, it } from 'vitest';

import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// CRM-1 — SavedList activation scope-catalog parity. SEED_SCOPE_KEYS 163 → 167
// (saved-list:{read,create,edit,delete}). The 29 RoleScope grants (read/create/
// edit × 9 operational roles + delete × tenant_admin/tenant_owner) live at the
// disjoint 0x1370+ range in seed.ts (append-don't-renumber); the run-time row
// count is exercised by the seed itself (seed-scrub + identity.integration).
const SAVED_LIST_SCOPES = [
  'saved-list:read',
  'saved-list:create',
  'saved-list:edit',
  'saved-list:delete',
] as const;

describe('CRM-1 SavedList — scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains all four saved-list scopes', () => {
    for (const key of SAVED_LIST_SCOPES) {
      expect(SEED_SCOPE_KEYS).toContain(key);
    }
  });

  it('the saved-list scopes match the scope-key format', () => {
    for (const key of SAVED_LIST_SCOPES) {
      expect(key).toMatch(SCOPE_KEY_FORMAT);
    }
  });

  it('each saved-list scope appears exactly once (no duplicate/renumber)', () => {
    for (const key of SAVED_LIST_SCOPES) {
      expect(SEED_SCOPE_KEYS.filter((k) => k === key)).toHaveLength(1);
    }
  });
});
