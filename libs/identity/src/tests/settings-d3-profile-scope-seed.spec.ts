import { describe, expect, it } from 'vitest';

import { PROFILE_ADMIN_SEED_BUNDLES } from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild D3 — tenant:admin:profile scope-catalog + grant-table
// parity. DEDICATED scope (Lead ruling: org-legal-identity ≠ app config).
// SEED_SCOPE_KEYS 81 → 82; 2 RoleScope grants (tenant_admin + tenant_owner)
// at the disjoint 0x920+ range in seed.ts.

function scopesFor(role: string): readonly string[] {
  return PROFILE_ADMIN_SEED_BUNDLES.filter(([r]) => r === role).flatMap(
    ([, scopes]) => scopes,
  );
}

describe('Settings Rebuild D3 — tenant:admin:profile scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains tenant:admin:profile exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('tenant:admin:profile');
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'tenant:admin:profile')).toHaveLength(1);
  });

  it('tenant:admin:profile matches the scope-key format', () => {
    expect('tenant:admin:profile').toMatch(SCOPE_KEY_FORMAT);
  });

  it('is DISTINCT from tenant:admin:settings (separable by design)', () => {
    expect(SEED_SCOPE_KEYS).toContain('tenant:admin:settings');
    expect('tenant:admin:profile').not.toBe('tenant:admin:settings');
  });
});

describe('Settings Rebuild D3 — tenant:admin:profile grant table', () => {
  it('tenant_admin + tenant_owner hold tenant:admin:profile', () => {
    expect(scopesFor('tenant_admin')).toContain('tenant:admin:profile');
    expect(scopesFor('tenant_owner')).toContain('tenant:admin:profile');
  });

  it('is admin-only (NOT granted to recruiters or other tiers)', () => {
    for (const role of ['recruiter', 'account_manager', 'sourcer', 'finance', 'auditor']) {
      expect(scopesFor(role)).not.toContain('tenant:admin:profile');
    }
  });

  it('grants exactly 2 RoleScope rows', () => {
    const rows = PROFILE_ADMIN_SEED_BUNDLES.flatMap(([role, scopes]) =>
      scopes.map((s) => `${role}:${s}`),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows).size).toBe(2);
  });
});
