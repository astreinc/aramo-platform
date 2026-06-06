import {
  COMPENSATION_FIELD_KEYS,
  COMPENSATION_VIEW_MARGIN_PERCENT,
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_SCOPES,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
  assertNonInvertibleBundle,
  omitMaskedCompensationFields,
} from '@aramo/field-masking';
import { describe, expect, it } from 'vitest';

import { D5_COMPENSATION_BUNDLES } from '../../prisma/seed.js';
import { SEED_ROLE_KEYS } from '../lib/dto/index.js';

// AUTHZ-D5 — seeded-bundle non-invertibility + per-role view-set proof.
//
// The catalog-level proof: walks the LOCKED matrix
// (D5_COMPENSATION_BUNDLES) and asserts THE ENFORCED INVARIANT mechanically
// across every role. This is the §4 PL-94 Gate 1 test the directive
// requires. The libs/field-masking unit tests prove the FUNCTIONS
// (compensation-field-map.spec.ts); this proves the SEED matches them.

// Roles exempt from the enforced invariant by design (see-all tier).
// holding view:pay + every spread scope is the intended see-all — not a
// leak. The exemption is keyed by role bundle, NOT by an "if Spread"
// branch in the runtime mask (which would defeat its purpose).
//
// Settings S4 adds auditor_with_financials to the bypass set: the role
// holds every comp scope by design (the compliance see-all-comp grant);
// the policy GATE that prevents the role from being granted lives at
// the role-assign path (read of tenant's audit.financials_enabled
// KNOWN_SETTING), NOT here. This file's job is the bundle-math proof;
// it doesn't model the GATE.
const SEE_ALL_ROLES = new Set([
  'tenant_admin',
  'tenant_owner',
  'auditor_with_financials',
]);

describe('AUTHZ-D5 — THE ENFORCED INVARIANT (no role holds view:pay + any spread)', () => {
  for (const [roleKey, scopes] of D5_COMPENSATION_BUNDLES) {
    const seeAll = SEE_ALL_ROLES.has(roleKey);
    it(`bundle for "${roleKey}"${seeAll ? ' (see-all exemption)' : ''} is non-invertible`, () => {
      expect(() =>
        assertNonInvertibleBundle(roleKey, scopes, { seeAll }),
      ).not.toThrow();
    });
  }

  it('every scope listed in any bundle is a recognised compensation:view:* scope', () => {
    const known = new Set<string>(COMPENSATION_VIEW_SCOPES);
    for (const [role, scopes] of D5_COMPENSATION_BUNDLES) {
      for (const s of scopes) {
        expect(known.has(s), `${role} holds unknown comp scope ${s}`).toBe(true);
      }
    }
  });

  it('see-all roles (TA / TO / auditor_with_financials) hold every compensation:view:* scope', () => {
    for (const role of SEE_ALL_ROLES) {
      const entry = D5_COMPENSATION_BUNDLES.find(([k]) => k === role);
      expect(entry, `${role} missing from D5_COMPENSATION_BUNDLES`).toBeDefined();
      if (entry === undefined) continue;
      const held = new Set(entry[1]);
      for (const s of COMPENSATION_VIEW_SCOPES) {
        expect(held.has(s), `${role} missing scope ${s}`).toBe(true);
      }
    }
  });

  it('the operational tiers (NOT see-all) never hold view:pay alongside a spread scope', () => {
    for (const [role, scopes] of D5_COMPENSATION_BUNDLES) {
      if (SEE_ALL_ROLES.has(role)) continue;
      const set = new Set(scopes);
      if (!set.has(COMPENSATION_VIEW_PAY)) continue;
      // The invariant: view:pay holders see NO spread scope.
      expect(set.has(COMPENSATION_VIEW_SPREAD_AMOUNT), `${role}: pay + spread:amount`).toBe(false);
      expect(set.has(COMPENSATION_VIEW_SPREAD_PERCENT), `${role}: pay + spread:percent`).toBe(false);
      expect(set.has(COMPENSATION_VIEW_MARGIN_PERCENT), `${role}: pay + margin:percent`).toBe(false);
    }
  });
});

// Per-role view-set proofs — the §4 PL-94 Gate 2. For each row in the
// LOCKED matrix, mask the FULL_VIEW with the role's seeded scopes and
// assert the resulting field set matches the matrix intent.
const FULL_VIEW: Record<string, unknown> = {
  id: 'r-1',
  title: 'Test Req',
  compensation_model: 'CONTRACT',
  pay_rate_amount: '60.00',
  pay_rate_currency: 'USD',
  pay_rate_period: 'HOURLY',
  bill_rate_amount: '80.00',
  bill_rate_currency: 'USD',
  bill_rate_period: 'HOURLY',
  placement_fee_percent: null,
  placement_fee_amount: null,
  salary_amount: null,
  salary_currency: null,
  margin_amount: '20.00',
  markup_percent: '33.33',
  margin_percent: '25.00',
};

function scopesFor(role: string): readonly string[] {
  const entry = D5_COMPENSATION_BUNDLES.find(([k]) => k === role);
  return entry ? entry[1] : [];
}

function maskedKeys(role: string): Set<string> {
  const out = omitMaskedCompensationFields({ ...FULL_VIEW }, scopesFor(role));
  return new Set(Object.keys(out).filter((k) => COMPENSATION_FIELD_KEYS.includes(k as never)));
}

describe('AUTHZ-D5 — per-role view-set matches the LOCKED matrix', () => {
  it('see-all tier (tenant_admin) sees every comp field', () => {
    expect([...maskedKeys('tenant_admin')].sort()).toEqual([...COMPENSATION_FIELD_KEYS].sort());
  });

  it('see-all tier (tenant_owner) sees every comp field', () => {
    expect([...maskedKeys('tenant_owner')].sort()).toEqual([...COMPENSATION_FIELD_KEYS].sort());
  });

  it('Settings S4 — auditor_with_financials sees every comp field (the see-all-comp grant)', () => {
    // Proves the bundle-shape contract: the role holds the see-all-comp set,
    // so the field-mask interceptor surfaces every comp field. The GATE
    // that prevents the role from being GRANTED to a membership (when
    // audit.financials_enabled=false) is exercised at the role-assign
    // path; this test asserts the post-grant behavior matches the see-all
    // tier (TA/TO) shape for comp visibility.
    expect([...maskedKeys('auditor_with_financials')].sort()).toEqual([
      ...COMPENSATION_FIELD_KEYS,
    ].sort());
  });

  it('recruiter sees pay/salary; bill + spread + fee masked', () => {
    expect([...maskedKeys('recruiter')].sort()).toEqual([
      'pay_rate_amount',
      'pay_rate_currency',
      'pay_rate_period',
      'salary_amount',
      'salary_currency',
    ]);
  });

  it('recruiting_manager = recruiter (P-only, AUTHZ-1b operational mirror)', () => {
    expect([...maskedKeys('recruiting_manager')].sort()).toEqual([...maskedKeys('recruiter')].sort());
  });

  it('lead_recruiter = recruiter (per the AUTHZ-1b "Recruiter verbatim" precedent)', () => {
    expect([...maskedKeys('lead_recruiter')].sort()).toEqual([...maskedKeys('recruiter')].sort());
  });

  it('back_office sees pay/salary (payroll-facing)', () => {
    expect([...maskedKeys('back_office')].sort()).toEqual([...maskedKeys('recruiter')].sort());
  });

  it('account_manager sees bill + fee + markup% + margin% + revenue; NO pay, NO margin_amount', () => {
    const keys = maskedKeys('account_manager');
    // Visible:
    expect(keys.has('bill_rate_amount')).toBe(true);
    expect(keys.has('bill_rate_currency')).toBe(true);
    expect(keys.has('bill_rate_period')).toBe(true);
    expect(keys.has('placement_fee_amount')).toBe(true);
    expect(keys.has('placement_fee_percent')).toBe(true);
    expect(keys.has('markup_percent')).toBe(true);
    expect(keys.has('margin_percent')).toBe(true);
    // Masked:
    expect(keys.has('pay_rate_amount')).toBe(false);
    expect(keys.has('salary_amount')).toBe(false);
    expect(keys.has('margin_amount')).toBe(false);
  });

  it('finance sees bill_rate (via revenue) + margin%; NO pay, NO fee, NO markup, NO margin_amount', () => {
    const keys = maskedKeys('finance');
    expect(keys.has('bill_rate_amount')).toBe(true);
    expect(keys.has('margin_percent')).toBe(true);
    expect(keys.has('pay_rate_amount')).toBe(false);
    expect(keys.has('placement_fee_amount')).toBe(false);
    expect(keys.has('markup_percent')).toBe(false);
    expect(keys.has('margin_amount')).toBe(false);
  });

  it('delivery_manager sees revenue + every spread/margin view; NO pay, NO fee', () => {
    const keys = maskedKeys('delivery_manager');
    expect(keys.has('bill_rate_amount')).toBe(true);
    expect(keys.has('margin_amount')).toBe(true);
    expect(keys.has('markup_percent')).toBe(true);
    expect(keys.has('margin_percent')).toBe(true);
    expect(keys.has('pay_rate_amount')).toBe(false);
    expect(keys.has('salary_amount')).toBe(false);
    expect(keys.has('placement_fee_amount')).toBe(false);
  });

  // Every catalog role NOT in D5_COMPENSATION_BUNDLES gets zero comp
  // scopes — proven programmatically (covers sourcer, auditor, candidate,
  // super_admin) so the test doesn't enumerate the role-key string
  // literals.
  it('every role absent from the bundle table sees no comp fields', () => {
    const bundleRoles = new Set(D5_COMPENSATION_BUNDLES.map(([k]) => k));
    const absentRoles = [...SEED_ROLE_KEYS].filter((k) => !bundleRoles.has(k));
    // Sanity: the four roles known to be intentionally absent per the
    // commit plan §2 matrix.
    expect(absentRoles.length).toBe(4);
    for (const role of absentRoles) {
      expect(maskedKeys(role).size, `${role} (absent role) leaked comp fields`).toBe(0);
    }
  });
});

// One additional sanity proof: the response shape is unchanged for
// requests without an actor (the interceptor passes through). This is
// not exercised here (interceptor lives at apps/api) — the contract is
// the maskFn behaviour: a SEPARATE see-all path is not needed because
// the see-all roles HOLD the scopes and the maskFn is uniformly
// scope-driven.
describe('AUTHZ-D5 — non-comp fields are preserved (the response shape contract)', () => {
  it('non-comp fields pass through every masked bundle (including empty-scope)', () => {
    for (const [role] of D5_COMPENSATION_BUNDLES) {
      const out = omitMaskedCompensationFields({ ...FULL_VIEW }, scopesFor(role));
      expect(out.id, `${role}: id missing`).toBe('r-1');
      expect(out.title, `${role}: title missing`).toBe('Test Req');
      // compensation_model is a discriminator label (not a $ value) — always visible.
      expect(out.compensation_model, `${role}: compensation_model missing`).toBe('CONTRACT');
    }
    // Same for a NON-bundled role (empty scopes):
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, []);
    expect(out.id).toBe('r-1');
    expect(out.compensation_model).toBe('CONTRACT');
  });
});
