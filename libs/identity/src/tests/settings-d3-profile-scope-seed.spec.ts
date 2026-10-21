import { describe, expect, it } from 'vitest';

import { PROFILE_ADMIN_SEED_BUNDLES, ORG_ADMIN_SEED_BUNDLES } from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild D3 — tenant:admin:profile scope-catalog + grant-table
// parity. DEDICATED scope (Lead ruling: org-legal-identity ≠ app config).
// SEED_SCOPE_KEYS 81 → 82; 2 RoleScope grants (tenant_admin + tenant_owner)
// at the disjoint 0x920+ range in seed.ts.

// ROLES-1 PR-2 — the organization tenant_admin (row 02b0) holds this scope through
// ORG_ADMIN_SEED_BUNDLES (its original org set); ats_admin (row 0010) no longer holds it.
function scopesFor(role: string): readonly string[] {
  return [...PROFILE_ADMIN_SEED_BUNDLES, ...ORG_ADMIN_SEED_BUNDLES].filter(([r]) => r === role).flatMap(
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
    // ROLES-1 PR-2 (§3.2, D-2) — organization-wide administration: not ATS-only.
    expect(scopesFor('ats_admin')).not.toContain('tenant:admin:profile');
  });

  it('is admin-only (NOT granted to recruiters or other tiers)', () => {
    for (const role of ['recruiter', 'account_manager', 'sourcer', 'finance', 'auditor']) {
      expect(scopesFor(role)).not.toContain('tenant:admin:profile');
    }
  });

  // ROLES-1 PR-2 — the dedicated bundle keeps only tenant_owner's row (the ats_admin
  // row id is retired, never reused); tenant_admin's grant is ORG_ADMIN_SEED_BUNDLES'.
  it('grants exactly 1 RoleScope row in the dedicated bundle', () => {
    const rows = PROFILE_ADMIN_SEED_BUNDLES.flatMap(([role, scopes]) =>
      scopes.map((s) => `${role}:${s}`),
    );
    expect(rows).toHaveLength(1);
    expect(new Set(rows).size).toBe(1);
  });
});
