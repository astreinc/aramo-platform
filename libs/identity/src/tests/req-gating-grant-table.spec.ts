import { describe, expect, it } from 'vitest';

import {
  AUTHZ1_BUNDLES,
  D5_COMPENSATION_BUNDLES,
  FINANCIALS_SEED_BUNDLES,
  REQ_GATING_SEED_BUNDLES,
  ROLE_SCOPE_ASSIGNMENTS,
} from '../../prisma/seed.js';

// PR-A1 Requisition-Gating Rework — THE GRANT-TABLE GATE (unit tier).
//
// The directive's §6 GRANT-TABLE gate asserts each of the 7 roles' effective
// scopes per the consolidated matrix (Directive v1.0 §2 as amended by v1.1,
// Option C for delivery_manager). This is the AUTHORITATIVE in-CI proof: the
// real-DB grant-table in identity.integration.spec.ts is skip-gated
// (ARAMO_RUN_INTEGRATION=1) and carries documented pre-existing staleness
// (HK-INTEGRATION-SPEC-COMP-STALE), so the matrix is locked HERE — read
// straight from the seed bundles, no DB.
//
// effectiveScopes(role) unions every seed bundle that grants to the role:
//   - ROLE_SCOPE_ASSIGNMENTS  (tenant_admin + recruiter base sets)
//   - AUTHZ1_BUNDLES          (the other 9 staffing roles' base sets)
//   - D5_COMPENSATION_BUNDLES (compensation:view/edit:*)
//   - FINANCIALS_SEED_BUNDLES (requisition:*:financials)
//   - REQ_GATING_SEED_BUNDLES (the PR-A1 deltas)
// The RoleScope upsert is by (role, scope), so the union IS the role's
// effective grant set (duplicates across bundles collapse).

type Bundle = ReadonlyArray<readonly [string, readonly string[]]>;

function effectiveScopes(role: string): Set<string> {
  const out = new Set<string>();
  const base = (ROLE_SCOPE_ASSIGNMENTS as Record<string, readonly string[]>)[role];
  if (base !== undefined) for (const s of base) out.add(s);
  const bundles: Bundle[] = [
    AUTHZ1_BUNDLES,
    D5_COMPENSATION_BUNDLES,
    FINANCIALS_SEED_BUNDLES,
    REQ_GATING_SEED_BUNDLES,
  ];
  for (const bundle of bundles) {
    for (const [k, scopes] of bundle) {
      if (k === role) for (const s of scopes) out.add(s);
    }
  }
  return out;
}

function holders(scope: string): string[] {
  // Every staffing role key that appears in any bundle.
  const roles = new Set<string>(Object.keys(ROLE_SCOPE_ASSIGNMENTS));
  for (const bundle of [AUTHZ1_BUNDLES, D5_COMPENSATION_BUNDLES, FINANCIALS_SEED_BUNDLES, REQ_GATING_SEED_BUNDLES]) {
    for (const [k] of bundle) roles.add(k);
  }
  return [...roles].filter((r) => effectiveScopes(r).has(scope)).sort();
}

describe('PR-A1 grant-table — recruiter (read-only on requisitions, sees pay not bill)', () => {
  const s = effectiveScopes('recruiter');
  it('LOST requisition:edit (read-only on requisitions)', () => {
    expect(s.has('requisition:edit')).toBe(false);
  });
  it('LOST compensation:edit:pay (read-only on compensation)', () => {
    expect(s.has('compensation:edit:pay')).toBe(false);
  });
  it('KEPT compensation:view:pay (still sees pay)', () => {
    expect(s.has('compensation:view:pay')).toBe(true);
  });
  it('does NOT have compensation:view:bill (sees pay, not bill)', () => {
    expect(s.has('compensation:view:bill')).toBe(false);
  });
  it('does NOT have requisition:edit:status (no status-edit affordance)', () => {
    expect(s.has('requisition:edit:status')).toBe(false);
  });
  it('does NOT have the profile scopes (not in the 5-role mgmt tier)', () => {
    expect(s.has('requisition:profile:generate')).toBe(false);
    expect(s.has('requisition:profile:edit')).toBe(false);
  });
  it('KEPT requisition:read + requisition:create (still browses + creates)', () => {
    expect(s.has('requisition:read')).toBe(true);
    expect(s.has('requisition:create')).toBe(true);
  });
});

describe('PR-A1 grant-table — recruiting_manager / lead_recruiter (+ view:bill + profile)', () => {
  for (const role of ['recruiting_manager', 'lead_recruiter']) {
    const s = effectiveScopes(role);
    it(`${role} keeps requisition:edit + compensation:edit:pay + view:pay`, () => {
      expect(s.has('requisition:edit')).toBe(true);
      expect(s.has('compensation:edit:pay')).toBe(true);
      expect(s.has('compensation:view:pay')).toBe(true);
    });
    it(`${role} GAINS compensation:view:bill (PR-A1 delta)`, () => {
      expect(s.has('compensation:view:bill')).toBe(true);
    });
    it(`${role} GAINS the profile scopes (5-role mgmt tier)`, () => {
      expect(s.has('requisition:profile:generate')).toBe(true);
      expect(s.has('requisition:profile:edit')).toBe(true);
    });
    it(`${role} does NOT gain financials (matrix: bill yes, financials no)`, () => {
      expect(s.has('requisition:view:financials')).toBe(false);
      expect(s.has('requisition:edit:financials')).toBe(false);
    });
  }
});

describe('PR-A1 grant-table — delivery_manager (status-only editor; Option C)', () => {
  const s = effectiveScopes('delivery_manager');
  it('GAINS requisition:edit:status (the net-new status-only scope)', () => {
    expect(s.has('requisition:edit:status')).toBe(true);
  });
  it('does NOT have requisition:edit (status-only, not a full editor)', () => {
    expect(s.has('requisition:edit')).toBe(false);
  });
  it('GAINS compensation:view:bill + requisition:view:financials (sees client economics)', () => {
    expect(s.has('compensation:view:bill')).toBe(true);
    expect(s.has('requisition:view:financials')).toBe(true);
  });
  it('does NOT have compensation:view:pay (Option C — D5 invariant: pay + DM spreads → bill)', () => {
    expect(s.has('compensation:view:pay')).toBe(false);
  });
  it('keeps its existing spread/margin/revenue views', () => {
    expect(s.has('compensation:view:revenue')).toBe(true);
    expect(s.has('compensation:view:spread:amount')).toBe(true);
    expect(s.has('compensation:view:spread:percent')).toBe(true);
    expect(s.has('compensation:view:margin:percent')).toBe(true);
  });
  it('does NOT have requisition:edit:financials (view-only on financials) or the profile scopes', () => {
    expect(s.has('requisition:edit:financials')).toBe(false);
    expect(s.has('requisition:profile:generate')).toBe(false);
    expect(s.has('requisition:profile:edit')).toBe(false);
  });
});

describe('PR-A1 grant-table — account_manager (UNCHANGED + profile)', () => {
  const s = effectiveScopes('account_manager');
  it('keeps requisition:edit + compensation:view/edit:bill + financials', () => {
    expect(s.has('requisition:edit')).toBe(true);
    expect(s.has('compensation:view:bill')).toBe(true);
    expect(s.has('compensation:edit:bill')).toBe(true);
    expect(s.has('requisition:view:financials')).toBe(true);
    expect(s.has('requisition:edit:financials')).toBe(true);
  });
  it('still does NOT have pay (agency-economics author, talent-economics blind)', () => {
    expect(s.has('compensation:view:pay')).toBe(false);
    expect(s.has('compensation:edit:pay')).toBe(false);
  });
  it('GAINS the profile scopes (5-role mgmt tier)', () => {
    expect(s.has('requisition:profile:generate')).toBe(true);
    expect(s.has('requisition:profile:edit')).toBe(true);
  });
});

describe('PR-A1 grant-table — tenant_admin / tenant_owner (full)', () => {
  for (const role of ['tenant_admin', 'tenant_owner']) {
    const s = effectiveScopes(role);
    it(`${role} holds requisition:edit + all comp edit + financials + profile`, () => {
      expect(s.has('requisition:edit')).toBe(true);
      expect(s.has('compensation:edit:pay')).toBe(true);
      expect(s.has('compensation:edit:bill')).toBe(true);
      expect(s.has('requisition:edit:financials')).toBe(true);
      expect(s.has('requisition:profile:generate')).toBe(true);
      expect(s.has('requisition:profile:edit')).toBe(true);
    });
  }
});

describe('PR-A1 grant-table — scope holder-sets (exact)', () => {
  it('requisition:edit:status → exactly {delivery_manager}', () => {
    expect(holders('requisition:edit:status')).toEqual(['delivery_manager']);
  });
  it('requisition:profile:generate → exactly the 5-role mgmt tier', () => {
    expect(holders('requisition:profile:generate')).toEqual(
      ['account_manager', 'lead_recruiter', 'recruiting_manager', 'tenant_admin', 'tenant_owner'].sort(),
    );
  });
  it('requisition:profile:edit → exactly the 5-role mgmt tier', () => {
    expect(holders('requisition:profile:edit')).toEqual(
      ['account_manager', 'lead_recruiter', 'recruiting_manager', 'tenant_admin', 'tenant_owner'].sort(),
    );
  });
  it('requisition:view:financials → {TA, TO, AM, delivery_manager} (DM added by PR-A1)', () => {
    expect(holders('requisition:view:financials')).toEqual(
      ['account_manager', 'delivery_manager', 'tenant_admin', 'tenant_owner'].sort(),
    );
  });
  it('requisition:edit:financials → {TA, TO, AM} only (DM is view-only)', () => {
    expect(holders('requisition:edit:financials')).toEqual(
      ['account_manager', 'tenant_admin', 'tenant_owner'].sort(),
    );
  });
  it('compensation:view:bill → adds RM/LR/DM to the {TA,TO,AM,auditor_with_financials} base', () => {
    const set = new Set(holders('compensation:view:bill'));
    expect(set.has('recruiting_manager')).toBe(true);
    expect(set.has('lead_recruiter')).toBe(true);
    expect(set.has('delivery_manager')).toBe(true);
    expect(set.has('recruiter')).toBe(false); // recruiter sees pay, not bill
  });
});
