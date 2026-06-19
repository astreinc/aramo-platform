import { describe, expect, it } from 'vitest';

import { AUDIT_READ_SEED_BUNDLES } from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild D2 — audit:read scope-catalog + grant-table parity.
// SEED_SCOPE_KEYS 80 → 81 (audit:read). The 2 RoleScope grants (tenant_admin +
// tenant_owner) live at the disjoint 0x910+ range in seed.ts.

function scopesFor(role: string): readonly string[] {
  return AUDIT_READ_SEED_BUNDLES.filter(([r]) => r === role).flatMap(
    ([, scopes]) => scopes,
  );
}

describe('Settings Rebuild D2 — audit:read scope catalog parity', () => {
  it('SEED_SCOPE_KEYS contains audit:read exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('audit:read');
    expect(SEED_SCOPE_KEYS.filter((k) => k === 'audit:read')).toHaveLength(1);
  });

  it('audit:read matches the scope-key format', () => {
    expect('audit:read').toMatch(SCOPE_KEY_FORMAT);
  });
});

// THE READ-SURFACE GATE — GET /v1/tenant/audit-events is reachable only by a
// JWT carrying audit:read, which derives from these grants.
describe('Settings Rebuild D2 — audit:read grant table', () => {
  it('tenant_admin + tenant_owner hold audit:read', () => {
    expect(scopesFor('tenant_admin')).toContain('audit:read');
    expect(scopesFor('tenant_owner')).toContain('audit:read');
  });

  it('audit:read is admin/compliance-only (NOT granted to recruiters)', () => {
    for (const role of ['recruiter', 'account_manager', 'sourcer', 'finance']) {
      expect(scopesFor(role)).not.toContain('audit:read');
    }
  });

  it('grants exactly 2 RoleScope rows', () => {
    const rows = AUDIT_READ_SEED_BUNDLES.flatMap(([role, scopes]) =>
      scopes.map((s) => `${role}:${s}`),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows).size).toBe(2);
  });
});
