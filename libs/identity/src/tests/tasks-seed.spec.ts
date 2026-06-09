import { describe, expect, it } from 'vitest';

import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Tasks backend — scope-catalog parity. SEED_SCOPE_KEYS 70 → 72 (task:read +
// task:write). The 18 RoleScope grants (9 operational roles × 2 scopes) live
// at the disjoint 0x81c+ range in seed.ts (append-don't-renumber); the
// run-time row count is exercised by the seed itself.
describe('Tasks backend — scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains task:read + task:write', () => {
    expect(SEED_SCOPE_KEYS).toContain('task:read');
    expect(SEED_SCOPE_KEYS).toContain('task:write');
  });

  it('the task scopes match the scope-key format', () => {
    expect('task:read').toMatch(SCOPE_KEY_FORMAT);
    expect('task:write').toMatch(SCOPE_KEY_FORMAT);
  });

  it('each task scope appears exactly once (no duplicate/renumber)', () => {
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'task:read')).toHaveLength(1);
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'task:write')).toHaveLength(1);
  });
});
