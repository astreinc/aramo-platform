import { describe, expect, it } from 'vitest';

import { PLACEMENT_SEED_BUNDLES } from '../../prisma/seed.js';

// Track 3 / E1-b — THE PLACEMENT ROLE-MATRIX GATE (unit tier).
//
// The five placement scopes shipped at E1-b with ZERO default grants (fail-
// closed; no ratified matrix existed). The Placement-Role-Matrix seam grants
// them to the canonical tenant roles. This spec locks that matrix straight
// from PLACEMENT_SEED_BUNDLES — no DB — so the grant table is authoritative in
// the fast unit lane; the cross-bundle resolved truth (that no OTHER bundle
// leaks a placement scope, and every non-granted role resolves to none) is
// proven against the real seed in identity.integration.spec.ts test 17.
//
// LOCKED matrix:
//   recruiter        → read + create + transition            (NOT activate/terminate)
//   account_manager  → read + create + transition + activate + terminate
//   tenant_admin     → read + create + transition + activate + terminate
//   tenant_owner     → read + create + transition + activate + terminate  (Owner = Admin)
// super_admin (the platform / "SaaS Owner" operator) and every other tenant
// role receive NOTHING (no prose-hierarchy inheritance).

const PLACEMENT_SCOPES = [
  'placement:read',
  'placement:create',
  'placement:transition',
  'placement:activate',
  'placement:terminate',
] as const;

const FULL_FIVE = [...PLACEMENT_SCOPES].sort();
const RECRUITER_THREE = ['placement:create', 'placement:read', 'placement:transition'];

function placementScopesFor(role: string): string[] {
  return PLACEMENT_SEED_BUNDLES.filter(([r]) => r === role)
    .flatMap(([, scopes]) => scopes)
    .sort();
}

describe('Placement role matrix — grant table (unit)', () => {
  it('grants placement scopes to EXACTLY four roles', () => {
    const roles = [...new Set(PLACEMENT_SEED_BUNDLES.map(([r]) => r))].sort();
    expect(roles).toEqual(
      ['account_manager', 'recruiter', 'tenant_admin', 'tenant_owner'].sort(),
    );
  });

  it('grants ONLY the five placement scopes (no scope outside the catalog subset)', () => {
    const granted = new Set(PLACEMENT_SEED_BUNDLES.flatMap(([, s]) => s));
    for (const scope of granted) {
      expect(PLACEMENT_SCOPES).toContain(scope);
    }
  });

  it('recruiter → read + create + transition, and NOT activate/terminate', () => {
    expect(placementScopesFor('recruiter')).toEqual(RECRUITER_THREE);
    expect(placementScopesFor('recruiter')).not.toContain('placement:activate');
    expect(placementScopesFor('recruiter')).not.toContain('placement:terminate');
  });

  it('account_manager → the full five (incl. activate + terminate)', () => {
    expect(placementScopesFor('account_manager')).toEqual(FULL_FIVE);
  });

  it('tenant_admin → the full five', () => {
    expect(placementScopesFor('tenant_admin')).toEqual(FULL_FIVE);
  });

  it('tenant_owner → the full five AND mirrors tenant_admin (Owner = Admin scope set)', () => {
    expect(placementScopesFor('tenant_owner')).toEqual(FULL_FIVE);
    expect(placementScopesFor('tenant_owner')).toEqual(placementScopesFor('tenant_admin'));
  });

  it('the platform / SaaS-operator role (super_admin) receives NO placement scopes', () => {
    expect(placementScopesFor('super_admin')).toEqual([]);
  });

  it('no other tenant-operational role receives a placement scope', () => {
    // The portal-user role (a non-operational principal) is likewise absent
    // from PLACEMENT_SEED_BUNDLES; its full zero-placement resolved set is
    // asserted in identity.integration.spec.ts test 17.
    for (const role of [
      'delivery_manager',
      'recruiting_manager',
      'sourcer',
      'lead_recruiter',
      'finance',
      'auditor',
      'back_office',
      'auditor_with_financials',
    ]) {
      expect(placementScopesFor(role)).toEqual([]);
    }
  });

  it('yields exactly 18 role-scope pairs (3 + 5 + 5 + 5), with no duplicate pair', () => {
    const pairs = PLACEMENT_SEED_BUNDLES.flatMap(([r, s]) => s.map((sc) => `${r}:${sc}`));
    expect(pairs).toHaveLength(18);
    expect(new Set(pairs).size).toBe(18);
  });
});
