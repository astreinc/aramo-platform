import { describe, expect, it } from 'vitest';

import { AUTHZ1_BUNDLES, PLACEMENT_SEED_BUNDLES } from '../../prisma/seed.js';

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
// LOCKED matrix (E1-b five scopes + E4 placement:replace):
//   recruiter        → read + create + transition                       (NOT activate/terminate/replace)
//   account_manager  → read + create + transition + activate + terminate + replace
//   tenant_admin     → read + create + transition + activate + terminate + replace
//   tenant_owner     → read + create + transition + activate + terminate + replace  (Owner = Admin)
// super_admin (the platform / "SaaS Owner" operator) and every other tenant
// role receive NOTHING (no prose-hierarchy inheritance).

const PLACEMENT_SCOPES = [
  'placement:read',
  'placement:create',
  'placement:transition',
  'placement:activate',
  'placement:terminate',
  'placement:replace',
] as const;

const FULL_SIX = [...PLACEMENT_SCOPES].sort();
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

  it('grants ONLY the six placement scopes (no scope outside the catalog subset)', () => {
    const granted = new Set(PLACEMENT_SEED_BUNDLES.flatMap(([, s]) => s));
    for (const scope of granted) {
      expect(PLACEMENT_SCOPES).toContain(scope);
    }
  });

  it('recruiter → read + create + transition, and NOT activate/terminate/replace', () => {
    expect(placementScopesFor('recruiter')).toEqual(RECRUITER_THREE);
    expect(placementScopesFor('recruiter')).not.toContain('placement:activate');
    expect(placementScopesFor('recruiter')).not.toContain('placement:terminate');
    expect(placementScopesFor('recruiter')).not.toContain('placement:replace');
  });

  it('account_manager → the full six (incl. activate + terminate + replace)', () => {
    expect(placementScopesFor('account_manager')).toEqual(FULL_SIX);
    expect(placementScopesFor('account_manager')).toContain('placement:replace');
  });

  it('tenant_admin → the full six', () => {
    expect(placementScopesFor('tenant_admin')).toEqual(FULL_SIX);
  });

  it('tenant_owner → the full six AND mirrors tenant_admin (Owner = Admin scope set)', () => {
    expect(placementScopesFor('tenant_owner')).toEqual(FULL_SIX);
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

  it('yields exactly 21 role-scope pairs (3 + 6 + 6 + 6), with no duplicate pair', () => {
    const pairs = PLACEMENT_SEED_BUNDLES.flatMap(([r, s]) => s.map((sc) => `${r}:${sc}`));
    expect(pairs).toHaveLength(21);
    expect(new Set(pairs).size).toBe(21);
  });
});

// recruiting_manager is called out by name (Gate-6 FIX_NOW): a management-tier
// role sitting ABOVE recruiter operationally (Recruiter's set + tenant:admin:
// user-manage per AUTHZ-1b) that a reader might expect to hold placement
// authority. Its zero-placement posture must be shown to be INTENTIONAL — not an
// accidental omission (the role is real and actively granted) and not an
// inheritance artifact (grants do NOT flow up the role hierarchy from recruiter).
describe('Placement role matrix — recruiting_manager is intentionally excluded', () => {
  const rmAuthz1 = AUTHZ1_BUNDLES.filter(([r]) => r === 'recruiting_manager').flatMap(([, s]) => s);
  const rmPlacement = placementScopesFor('recruiting_manager');

  it('recruiting_manager is a real, actively-granted role (holds management scopes) — so absence is not an inactive-role artifact', () => {
    expect(rmAuthz1.length).toBeGreaterThan(0);
    expect(rmAuthz1).toContain('tenant:admin:user-manage');
  });

  it('recruiting_manager receives ZERO placement scopes and is absent from PLACEMENT_SEED_BUNDLES by design', () => {
    expect(rmPlacement).toEqual([]);
    expect(PLACEMENT_SEED_BUNDLES.map(([r]) => r)).not.toContain('recruiting_manager');
  });

  it('the zero-placement posture is deliberate, NOT hierarchy inheritance: recruiting_manager sits above recruiter yet inherits none of recruiter’s placement grants', () => {
    // recruiter IS granted placement (below) — if grants flowed up the tier,
    // recruiting_manager would carry them. It does not.
    expect(placementScopesFor('recruiter')).toEqual(RECRUITER_THREE);
    expect(rmPlacement).toEqual([]);
    // And it holds none of the manager-tier placement scopes either.
    expect(rmPlacement).not.toContain('placement:activate');
    expect(rmPlacement).not.toContain('placement:terminate');
    expect(rmPlacement).not.toContain('placement:replace');
  });
});
