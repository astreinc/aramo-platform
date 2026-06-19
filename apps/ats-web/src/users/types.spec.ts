import { describe, expect, it } from 'vitest';

import {
  TENANT_ASSIGNABLE_ROLES,
  TENANT_ASSIGNABLE_ROLE_KEYS,
  findRoleEntry,
} from './types';

// Settings S5b — the roles-catalog SMOKE SPEC (ruling 2).
//
// THE GUARD: the FE hand-mirrors the 13 tenant-tier assignable roles
// from libs/identity/prisma/seed.ts. If the seed grows a 14th key OR
// renames a key, this spec MUST fail — turning silent drift into a
// loud test failure at the next FE PR.
//
// If you are reading this because the spec failed: a tenant-catalog
// role changed in the seed. Update the mirror in users/types.ts to
// match, then update this spec's expected set. (A GET-roles-catalog
// backend endpoint would remove the mirror entirely — filed as a
// future follow-up.)
//
// The expected set excludes `super_admin` (platform-only — not
// assignable from the tenant surface).

const EXPECTED_TENANT_ROLES = Object.freeze([
  'tenant_owner',
  'tenant_admin',
  'delivery_manager',
  'account_manager',
  'recruiting_manager',
  'lead_recruiter',
  'sourcer',
  'recruiter',
  'finance',
  'auditor',
  'back_office',
  'candidate',
  'auditor_with_financials',
]);

describe('TENANT_ASSIGNABLE_ROLES — the smoke spec (drift guard)', () => {
  it('exposes exactly the 13 tenant-tier role keys (super_admin excluded)', () => {
    expect([...TENANT_ASSIGNABLE_ROLE_KEYS].sort()).toEqual(
      [...EXPECTED_TENANT_ROLES].sort(),
    );
    expect(TENANT_ASSIGNABLE_ROLE_KEYS).toHaveLength(13);
  });

  it('every entry has a label and a description (R10 vocab — no scope-key math)', () => {
    for (const entry of TENANT_ASSIGNABLE_ROLES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      // R10: no scope-key colons leaking into user copy.
      expect(entry.label).not.toMatch(/:/);
      expect(entry.description).not.toMatch(/compensation:view:/);
    }
  });

  it('auditor_with_financials carries the S4 setting precondition', () => {
    const entry = findRoleEntry('auditor_with_financials');
    expect(entry).toBeDefined();
    expect(entry?.requiresSetting?.key).toBe('audit.financials_enabled');
    expect(entry?.requiresSetting?.disabledMessage).toMatch(
      /financial-auditor grant/i,
    );
  });

  it('no other role carries a settings precondition (only S4 today)', () => {
    const withPrecondition = TENANT_ASSIGNABLE_ROLES.filter(
      (r) => r.requiresSetting !== undefined,
    );
    expect(withPrecondition.map((r) => r.key)).toEqual([
      'auditor_with_financials',
    ]);
  });

  it('findRoleEntry returns the entry by key and undefined for unknown', () => {
    expect(findRoleEntry('recruiter')?.label).toBe('Recruiter');
    expect(findRoleEntry('finance')?.label).toBe('Finance');
    expect(findRoleEntry('nope')).toBeUndefined();
  });

  it('super_admin is NOT in the assignable catalog (platform-only)', () => {
    expect(findRoleEntry('super_admin')).toBeUndefined();
  });

  it('candidate IS in the catalog (ruling 5 — mirrors the seed)', () => {
    expect(findRoleEntry('candidate')).toBeDefined();
  });
});
