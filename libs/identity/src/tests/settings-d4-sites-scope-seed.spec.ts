import { describe, expect, it } from 'vitest';

import { SITES_ADMIN_SEED_BUNDLES } from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild D4 — tenant:admin:sites scope-catalog + grant-table parity.
// DEDICATED scope (Lead ruling: sites/branches = org STRUCTURE, separable from
// config and legal identity). SEED_SCOPE_KEYS 82 → 83; 2 RoleScope grants
// (tenant_admin + tenant_owner) at the disjoint 0x930+ range in seed.ts.

function scopesFor(role: string): readonly string[] {
  return SITES_ADMIN_SEED_BUNDLES.filter(([r]) => r === role).flatMap(
    ([, scopes]) => scopes,
  );
}

describe('Settings Rebuild D4 — tenant:admin:sites scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains tenant:admin:sites exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('tenant:admin:sites');
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'tenant:admin:sites')).toHaveLength(1);
  });

  it('tenant:admin:sites matches the scope-key format', () => {
    expect('tenant:admin:sites').toMatch(SCOPE_KEY_FORMAT);
  });

  it('is DISTINCT from tenant:admin:settings and tenant:admin:profile (separable by design)', () => {
    expect(SEED_SCOPE_KEYS).toContain('tenant:admin:settings');
    expect(SEED_SCOPE_KEYS).toContain('tenant:admin:profile');
    expect('tenant:admin:sites').not.toBe('tenant:admin:settings');
    expect('tenant:admin:sites').not.toBe('tenant:admin:profile');
  });
});

describe('Settings Rebuild D4 — tenant:admin:sites grant table', () => {
  it('tenant_admin + tenant_owner hold tenant:admin:sites', () => {
    expect(scopesFor('tenant_admin')).toContain('tenant:admin:sites');
    expect(scopesFor('tenant_owner')).toContain('tenant:admin:sites');
  });

  it('is admin-only (NOT granted to recruiters or other tiers)', () => {
    for (const role of ['recruiter', 'account_manager', 'sourcer', 'finance', 'auditor']) {
      expect(scopesFor(role)).not.toContain('tenant:admin:sites');
    }
  });

  it('grants exactly 2 RoleScope rows', () => {
    const rows = SITES_ADMIN_SEED_BUNDLES.flatMap(([role, scopes]) =>
      scopes.map((s) => `${role}:${s}`),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows).size).toBe(2);
  });
});
