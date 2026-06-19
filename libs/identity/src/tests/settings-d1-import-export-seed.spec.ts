import { describe, expect, it } from 'vitest';

import { IMPORT_EXPORT_SEED_BUNDLES } from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Helper: the set of scopes granted to a role across the bundle.
function scopesFor(role: string): readonly string[] {
  return IMPORT_EXPORT_SEED_BUNDLES.filter(([r]) => r === role).flatMap(
    ([, scopes]) => scopes,
  );
}

// Settings Rebuild D1 — scope-catalog parity. SEED_SCOPE_KEYS 78 → 80
// (import:read + export:read). These close the substrate-audit gap-and-note:
// both scopes were referenced by their controllers (libs/import, libs/export)
// but never in the seed catalog, so the settings Import + Export LIVE sections
// would 403 for every JWT. The 10 RoleScope grants (import:read × 8 operational
// roles + export:read × 2 admin roles) live at the disjoint 0x900+ range in
// seed.ts (append-don't-renumber); the run-time row count is exercised by the
// seed itself.
describe('Settings Rebuild D1 — import/export scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains import:read + export:read', () => {
    expect(SEED_SCOPE_KEYS).toContain('import:read');
    expect(SEED_SCOPE_KEYS).toContain('export:read');
  });

  it('the import/export scopes match the scope-key format', () => {
    expect('import:read').toMatch(SCOPE_KEY_FORMAT);
    expect('export:read').toMatch(SCOPE_KEY_FORMAT);
  });

  it('each scope appears exactly once (no duplicate/renumber)', () => {
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'import:read')).toHaveLength(1);
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'export:read')).toHaveLength(1);
  });
});

// THE LIVE-SURFACE GATE — the settings Import + Export sections are LIVE only
// if a tenant_admin JWT carries the scope its controller gates on. tenant_admin
// derives its JWT scopes from these RoleScope grants, so this is the chain that
// makes the controllers return data (not 403) for an admin.
describe('Settings Rebuild D1 — import/export grant table', () => {
  it('tenant_admin holds BOTH import:read and export:read (Export is admin-gated)', () => {
    const admin = scopesFor('tenant_admin');
    expect(admin).toContain('import:read');
    expect(admin).toContain('export:read');
  });

  it('tenant_owner mirrors tenant_admin (owner ≥ admin)', () => {
    const owner = scopesFor('tenant_owner');
    expect(owner).toContain('import:read');
    expect(owner).toContain('export:read');
  });

  it('import:read reaches the recruiter+ operational tier', () => {
    for (const role of [
      'account_manager',
      'recruiting_manager',
      'recruiter',
      'lead_recruiter',
      'back_office',
      'delivery_manager',
    ]) {
      expect(scopesFor(role)).toContain('import:read');
    }
  });

  it('export:read is admin-only (not granted to base recruiter)', () => {
    expect(scopesFor('recruiter')).not.toContain('export:read');
  });

  it('grants exactly 10 RoleScope rows (import:read × 8 + export:read × 2)', () => {
    const rows = IMPORT_EXPORT_SEED_BUNDLES.flatMap(([role, scopes]) =>
      scopes.map((s) => `${role}:${s}`),
    );
    expect(rows).toHaveLength(10);
    expect(new Set(rows).size).toBe(10); // no duplicates
  });
});
