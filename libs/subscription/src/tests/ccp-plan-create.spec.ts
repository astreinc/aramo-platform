import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  CommercialPayloadError,
  canTransitionFor,
  isApplyExpirable,
  isCatalogApplicable,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import { COMMERCIAL_CHAIN_PANEL } from '../lib/commercial/commercial-operator-roster.service.js';
import { type CommercialPolicyContent } from '../lib/commercial/commercial-policy.js';
import {
  PLAN_CREATE_PAYLOAD_KEYS,
  type PlanCreatePayload,
  planCreateAvailableKeys,
  planCreateContent,
  planCreatePayloadErrors,
  planRowOf,
} from '../lib/commercial/commercial-plan-create.js';
import { FEATURE_AVAILABILITY } from '../lib/feature-availability.js';
import { parsePlanVersionContent, planVersionChecksum } from '../lib/plan-version.js';

import { VALID } from './support/ccp-plan-create.js';

// CCP PLAN_CREATE (Aramo-CCP-Amendment-PLAN_CREATE-Console-Plan-Creation, catalog row 17) — the pure
// half: the catalog entry (PC-1), the chain (PC-2), the closed payload and its pricing rules (PC-3),
// the available-capability rule (PC-4), and the rows and version-1 content the apply writes (PC-7).

const POLICY = { approval_expiry_hours: 72 } as unknown as CommercialPolicyContent;


const errs = (p: Record<string, unknown>) => planCreatePayloadErrors(p);
const withP = (patch: Partial<Record<keyof PlanCreatePayload, unknown>>) => ({ ...VALID, ...patch }) as Record<string, unknown>;

describe('CCP PLAN_CREATE catalog entry and chain (PC-1, PC-2)', () => {
  it('PC-U-1 catalog row 17: PLAN_CREATE is catalog, not tenant-scoped, requested through platform:catalog:draft; the closed set is 17', () => {
    expect(COMMERCIAL_ACTION_TYPES).toHaveLength(17);
    expect(COMMERCIAL_ACTION_TYPES[16]).toBe('PLAN_CREATE');
    expect(COMMERCIAL_ACTIONS.PLAN_CREATE).toEqual({ domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft', requester_role: null });
    // No new requester scope: platform:catalog:draft governs exactly the three catalog actions.
    expect(Object.entries(COMMERCIAL_ACTIONS).filter(([, d]) => d.requester_scope === 'platform:catalog:draft').map(([a]) => a).sort()).toEqual(['PLAN_CREATE', 'PLAN_RETIRE', 'PLAN_VERSION_PUBLISH']);
  });

  it('PC-U-2 the chain is Finance → Owner, always, with the catalog step scopes (owner: approve + publish), the same as a version publish', () => {
    const c = resolveRequiredChain('PLAN_CREATE', VALID as unknown as Record<string, unknown>, POLICY);
    expect(c.rule).toBe('FINANCE_THEN_OWNER');
    expect(c.steps).toEqual([
      { step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:catalog:approve'] },
      { step_index: 1, role_key: 'platform_owner', scope_keys: ['platform:catalog:approve', 'platform:catalog:publish'] },
    ]);
    expect(c.steps).toEqual(resolveRequiredChain('PLAN_VERSION_PUBLISH', {}, POLICY).steps);
    // A free plan or a contract plan gets the same chain (no threshold, no bypass).
    expect(resolveRequiredChain('PLAN_CREATE', { ...VALID, sales_model: 'FREE', list_price_minor: 0 }, POLICY).rule).toBe('FINANCE_THEN_OWNER');
    // The approver-roster panel counts PLAN_CREATE under the catalog-publish chain.
    expect(COMMERCIAL_CHAIN_PANEL.find((p) => p.key === 'CATALOG_PUBLISH')?.actions).toContain('PLAN_CREATE');
  });

  it('PC-U-3 transitions: the A6 apply set with the AD-4 expiry, applied by the catalog apply', () => {
    expect(isCatalogApplicable('PLAN_CREATE')).toBe(true);
    expect(isApplyExpirable('PLAN_CREATE')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'APPROVED', 'APPLYING')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'APPLY_FAILED', 'APPLYING')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'APPLYING', 'APPLIED')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'APPLYING', 'APPLY_FAILED')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'APPROVED', 'APPLY_EXPIRED')).toBe(true);
    expect(canTransitionFor('PLAN_CREATE', 'DRAFT', 'APPLYING')).toBe(false);
    expect(canTransitionFor('PLAN_CREATE', 'PENDING_APPROVAL', 'APPLYING')).toBe(false);
    expect(canTransitionFor('PLAN_CREATE', 'APPLYING', 'WITHDRAWN')).toBe(false);
    expect(canTransitionFor('PLAN_CREATE', 'APPLY_FAILED', 'WITHDRAWN')).toBe(false);
  });
});

describe('CCP PLAN_CREATE payload (PC-3)', () => {
  it('PC-U-4 a complete Sign plan is valid, and validatePayload returns it', () => {
    expect(errs(VALID as unknown as Record<string, unknown>)).toEqual([]);
    expect(validatePayload('PLAN_CREATE', VALID)).toEqual(VALID);
  });

  it('PC-U-5 closed key set: every key required, no extra key (not even a provider price or the sellable flag)', () => {
    const missing = { ...VALID } as Record<string, unknown>;
    delete missing['display_order'];
    expect(errs(missing)).toContain('payload.display_order is required');
    expect(errs(withP({ provider_price_ref: 'price_123' } as never))).toContain('payload.provider_price_ref is not a field of this action');
    expect(errs(withP({ sellable: true } as never))).toContain('payload.sellable is not a field of this action');
    expect(PLAN_CREATE_PAYLOAD_KEYS).toHaveLength(17);
  });

  it('PC-U-6 identity fields: plan key shape, the product registry, tenant kind, sales channel (never OPERATOR), name, description', () => {
    expect(errs(withP({ plan_key: 'Bad Key' })).join('|')).toMatch(/plan_key must be/);
    expect(errs(withP({ plan_key: 'x' })).join('|')).toMatch(/plan_key must be/);
    expect(errs(withP({ product_key: 'ats' })).join('|')).toMatch(/product_key must be one of sign/);
    expect(errs(withP({ tenant_kind: null })).join('|')).toMatch(/tenant_kind must be one of PERSONAL, BUSINESS/);
    expect(errs(withP({ sales_model: 'OPERATOR' })).join('|')).toMatch(/sales_model must be one of SELF_SERVICE, FREE, CONTACT_SALES/);
    expect(errs(withP({ name: '' })).join('|')).toMatch(/name must be/);
    expect(errs(withP({ name: ' Team' })).join('|')).toMatch(/name must be/);
    expect(errs(withP({ name: 'x'.repeat(101) })).join('|')).toMatch(/name must be/);
    expect(errs(withP({ description: 'x'.repeat(501) })).join('|')).toMatch(/description must be/);
    expect(errs(withP({ description: null }))).toEqual([]);
    expect(errs(withP({ display_order: 900 })).join('|')).toMatch(/display_order must be an integer between 1 and 899/);
    expect(errs(withP({ display_order: 0 })).join('|')).toMatch(/display_order/);
    expect(errs(withP({ commitment_months: 0 })).join('|')).toMatch(/commitment_months/);
    expect(errs(withP({ eligibility: 'ATS_SUBSCRIPTION', commitment_months: 12, support_tier: 'CONTRACTED' }))).toEqual([]);
    expect(errs(withP({ eligibility: 'OTHER' })).join('|')).toMatch(/eligibility/);
    expect(errs(withP({ support_tier: 'PREMIUM' })).join('|')).toMatch(/support_tier/);
  });

  it('PC-U-7 pricing per sales channel: SELF_SERVICE ≥ 1 USD/MONTH; FREE = 0; CONTACT_SALES has no price, currency or interval', () => {
    expect(errs(withP({ list_price_minor: 0 })).join('|')).toMatch(/SELF_SERVICE plan needs list_price_minor of at least 1/);
    expect(errs(withP({ list_price_minor: 12.5 })).join('|')).toMatch(/SELF_SERVICE/);
    expect(errs(withP({ currency: 'EUR' })).join('|')).toMatch(/currency must be USD/);
    expect(errs(withP({ billing_interval: 'YEAR' })).join('|')).toMatch(/billing_interval must be MONTH/);
    expect(errs(withP({ sales_model: 'FREE', list_price_minor: 0, tenant_kind: 'PERSONAL' }))).toEqual([]);
    expect(errs(withP({ sales_model: 'FREE', list_price_minor: 500 })).join('|')).toMatch(/FREE plan has list_price_minor 0/);
    expect(errs(withP({ sales_model: 'CONTACT_SALES', list_price_minor: null, currency: null, billing_interval: null }))).toEqual([]);
    expect(errs(withP({ sales_model: 'CONTACT_SALES', list_price_minor: 5000 })).join('|')).toMatch(/CONTACT_SALES plan has no list price/);
    expect(errs(withP({ sales_model: 'CONTACT_SALES', list_price_minor: null, currency: 'USD', billing_interval: null })).join('|')).toMatch(/currency must be null/);
  });

  it('PC-U-8 allowances, windows and capacities: unlimited ⇔ null, non-negative, period MONTHLY, window on an own allowance, no repeats, bounded counts', () => {
    expect(errs(withP({ allowances: [{ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' }] }))).toEqual([]);
    expect(errs(withP({ allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 5, unlimited: true, period: 'MONTHLY' }] })).join('|')).toMatch(/must be unlimited/);
    expect(errs(withP({ allowances: [{ allowance_key: 'sign.envelopes', included_quantity: -1, unlimited: false, period: 'MONTHLY' }] })).join('|')).toMatch(/must be unlimited/);
    expect(errs(withP({ allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 5, unlimited: false, period: 'YEARLY' }] })).join('|')).toMatch(/period must be MONTHLY/);
    const env = VALID.allowances[0]!;
    expect(errs(withP({ allowances: [env, env] })).join('|')).toMatch(/allowances must not repeat a key/);
    expect(errs(withP({ allowance_windows: [{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 2 }] }))).toEqual([]);
    expect(errs(withP({ allowances: [], allowance_windows: [{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 2 }] })).join('|')).toMatch(/must name an allowance of this plan/);
    expect(errs(withP({ allowance_windows: [{ allowance_key: 'sign.envelopes', window_kind: 'WEEK', limit_quantity: 2 }] })).join('|')).toMatch(/window_kind must be DAY/);
    expect(errs(withP({ capacities: [{ capacity_key: 'sign.storage_bytes', limit_quantity: null, unlimited: false }] })).join('|')).toMatch(/must be unlimited/);
    expect(errs(withP({ features: Array.from({ length: 33 }, () => ({ feature_key: 'sign.team_collaboration', enabled: true })) })).join('|')).toMatch(/at most 32/);
    expect(errs(withP({ features: 'sign.team_collaboration' })).join('|')).toMatch(/features must be an array of objects/);
  });
});

describe('CCP PLAN_CREATE only AVAILABLE capabilities (PC-4)', () => {
  // sign.templates became AVAILABLE (PO authorization 2026-11-01); sign.branding is the dark key here.
  it('PC-U-9 a NOT_AVAILABLE feature is refused even when disabled, with the stable code and the key named', () => {
    const e = errs(withP({ features: [{ feature_key: 'sign.branding', enabled: false }] }));
    expect(e).toEqual(['PLAN_CREATE_FEATURE_NOT_AVAILABLE: features[0].feature_key sign.branding is not an available capability (feature-availability.ts)']);
    // Surfaced as a refused payload with the code (validatePayload → the create route's 400 codes).
    try {
      validatePayload('PLAN_CREATE', withP({ features: [{ feature_key: 'sign.branding', enabled: true }] }));
      expect.unreachable();
    } catch (x) {
      expect(x).toBeInstanceOf(CommercialPayloadError);
      expect((x as CommercialPayloadError).errors.join('|')).toMatch(/^PLAN_CREATE_FEATURE_NOT_AVAILABLE: /);
    }
  });

  it('PC-U-10 unknown keys, NOT_AVAILABLE allowances / capacities and another product’s keys are refused', () => {
    expect(errs(withP({ features: [{ feature_key: 'sign.unknown_thing', enabled: true }] })).join('|')).toMatch(/PLAN_CREATE_FEATURE_NOT_AVAILABLE: .*sign.unknown_thing/);
    expect(errs(withP({ allowances: [{ allowance_key: 'sign.forms', included_quantity: 5, unlimited: false, period: 'MONTHLY' }] })).join('|')).toMatch(/PLAN_CREATE_FEATURE_NOT_AVAILABLE: .*sign.forms/);
    expect(errs(withP({ capacities: [{ capacity_key: 'sign.branding', limit_quantity: 1, unlimited: false }] })).join('|')).toMatch(/PLAN_CREATE_FEATURE_NOT_AVAILABLE: .*sign.branding/);
    expect(errs(withP({ features: [{ feature_key: 'ats.reports', enabled: true }] })).join('|')).toMatch(/ats.reports is not a sign capability/);
    expect(errs(withP({ features: [{ feature_key: 'esign.team_collaboration', enabled: true }] })).join('|')).toMatch(/is not a sign capability/);
  });

  it('PC-U-11 availability is read from the registry: flipping a key to AVAILABLE admits it; the console list is exactly the AVAILABLE sign keys', () => {
    const flipped = { ...FEATURE_AVAILABILITY, 'sign.branding': 'AVAILABLE' as const };
    expect(planCreatePayloadErrors(withP({ features: [{ feature_key: 'sign.branding', enabled: true }] }), flipped)).toEqual([]);
    const available = Object.entries(FEATURE_AVAILABILITY).filter(([, v]) => v === 'AVAILABLE').map(([k]) => k).sort();
    expect(planCreateAvailableKeys('sign')).toEqual(available);
    expect(planCreateAvailableKeys('sign')).not.toContain('sign.branding');
    expect(planCreateAvailableKeys('sign', flipped)).toContain('sign.branding');
  });
});

describe('CCP PLAN_CREATE rows and version 1 (PC-7, PC-10)', () => {
  it('PC-U-12 the plan row: the payload fields; ACTIVE, not sellable, no activation note, no reference price', () => {
    expect(planRowOf(VALID)).toEqual({
      key: 'aramo-sign-team-v2',
      product_key: 'sign',
      name: 'Team',
      description: 'For small teams.',
      tenant_kind: 'BUSINESS',
      sales_model: 'SELF_SERVICE',
      status: 'ACTIVE',
      sellable: false,
      list_price_minor: 1500,
      currency: 'USD',
      reference_price_minor: null,
      reference_price_substantiated: false,
      billing_interval: 'MONTH',
      commitment_months: null,
      eligibility: null,
      support_tier: 'BASIC',
      activation_note: null,
      display_order: 25,
    });
  });

  it('PC-U-13 version 1 content is format 1, parses strictly, keeps payload order, and its checksum is stable', () => {
    const c = planCreateContent(VALID);
    expect(parsePlanVersionContent(c)).toEqual(c);
    expect(c.plan.key).toBe(VALID.plan_key);
    expect(c.plan.reference_price_minor).toBeNull();
    expect(c.features.map((f) => f.feature_key)).toEqual(['sign.team_collaboration', 'sign.in_person_signing']);
    expect(planVersionChecksum(c)).toBe(planVersionChecksum(planCreateContent(JSON.parse(JSON.stringify(VALID)) as PlanCreatePayload)));
    expect(planVersionChecksum(c)).toMatch(/^[0-9a-f]{64}$/);
  });
});
