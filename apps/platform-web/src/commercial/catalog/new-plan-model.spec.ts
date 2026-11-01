import { describe, expect, it } from 'vitest';

import { planCreateEffectRows, summaryOf } from '../commercial-model';

import { EMPTY_NEW_PLAN, buildNewPlanPayload, dollarsToMinor, featureChoices, newPlanSummary, pendingPlanCreateLine, planCreateApplyable, type NewPlanForm } from './new-plan-model';

// CCP PLAN_CREATE (catalog row 17) — the "New plan" form model: the same rules as the backend (PC-3,
// PC-4) so the commit button is honest; only AVAILABLE capabilities are ever named.

const AVAILABLE = ['sign.envelopes', 'sign.in_person_signing', 'sign.storage_bytes', 'sign.team_collaboration'];
const FORM: NewPlanForm = {
  ...EMPTY_NEW_PLAN,
  planKey: 'aramo-sign-team-v2',
  name: 'Team',
  description: 'For small teams.',
  price: '15',
  envelopes: '100',
  storageGb: '10',
  features: ['sign.team_collaboration'],
  displayOrder: '25',
};

describe('CCP PLAN_CREATE new-plan form model', () => {
  it('PC-W-1 a complete self-service plan builds the closed PLAN_CREATE payload; every available feature is listed, only the chosen ones enabled', () => {
    const out = buildNewPlanPayload(FORM, AVAILABLE);
    expect(out.errors).toEqual([]);
    expect(out.payload).toEqual({
      plan_key: 'aramo-sign-team-v2',
      product_key: 'sign',
      tenant_kind: 'BUSINESS',
      sales_model: 'SELF_SERVICE',
      name: 'Team',
      description: 'For small teams.',
      list_price_minor: 1500,
      currency: 'USD',
      billing_interval: 'MONTH',
      commitment_months: null,
      eligibility: null,
      support_tier: 'BASIC',
      display_order: 25,
      allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 100, unlimited: false, period: 'MONTHLY' }],
      allowance_windows: [],
      capacities: [{ capacity_key: 'sign.storage_bytes', limit_quantity: 10 * 1024 ** 3, unlimited: false }],
      features: [
        { feature_key: 'sign.in_person_signing', enabled: false },
        { feature_key: 'sign.team_collaboration', enabled: true },
      ],
    });
  });

  it('PC-W-2 sales channels: FREE is 0 USD/MONTH; CONTACT_SALES has no price, currency or interval; ATS eligibility and commitment', () => {
    expect(buildNewPlanPayload({ ...FORM, salesModel: 'FREE', price: '' }, AVAILABLE).payload).toMatchObject({ list_price_minor: 0, currency: 'USD', billing_interval: 'MONTH' });
    expect(buildNewPlanPayload({ ...FORM, salesModel: 'CONTACT_SALES', price: '99' }, AVAILABLE).payload).toMatchObject({ list_price_minor: null, currency: null, billing_interval: null });
    expect(buildNewPlanPayload({ ...FORM, atsRequired: true, commitmentMonths: '12' }, AVAILABLE).payload).toMatchObject({ eligibility: 'ATS_SUBSCRIPTION', commitment_months: 12 });
    expect(buildNewPlanPayload({ ...FORM, envelopes: '', envelopesUnlimited: true, storageGb: '' }, AVAILABLE).payload).toMatchObject({
      allowances: [{ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' }],
      capacities: [],
    });
  });

  it('PC-W-3 invalid input is refused with every reason: key shape, existing key, name, price, display order, commitment', () => {
    expect(buildNewPlanPayload({ ...FORM, planKey: 'Bad Key' }, AVAILABLE).errors).toContain('Plan key: 2 to 100 lower-case letters, digits or hyphens.');
    expect(buildNewPlanPayload(FORM, AVAILABLE, ['aramo-sign-team-v2']).errors).toEqual(['Plan key: a plan with this key already exists.']);
    expect(buildNewPlanPayload({ ...FORM, name: '  ' }, AVAILABLE).errors).toEqual(['Name: 1 to 100 characters.']);
    expect(buildNewPlanPayload({ ...FORM, price: '0' }, AVAILABLE).errors).toEqual(['Price: a monthly price of at least $0.01.']);
    expect(buildNewPlanPayload({ ...FORM, price: '1.234' }, AVAILABLE).payload).toBeNull();
    expect(buildNewPlanPayload({ ...FORM, displayOrder: '900' }, AVAILABLE).errors).toEqual(['Display order: 1 to 899.']);
    expect(buildNewPlanPayload({ ...FORM, commitmentMonths: '0' }, AVAILABLE).errors).toEqual(['Commitment: 1 to 120 months, or empty.']);
    expect(dollarsToMinor('19.99')).toBe(1999);
  });

  it('PC-W-4 only AVAILABLE capabilities: a feature that is not offered is refused, and a NOT_AVAILABLE key is never listed', () => {
    expect(featureChoices(AVAILABLE)).toEqual(['sign.in_person_signing', 'sign.team_collaboration']);
    expect(buildNewPlanPayload({ ...FORM, features: ['sign.templates'] }, AVAILABLE).errors).toEqual(['Feature sign.templates is not available.']);
    // Without the envelope key available, no envelope allowance is built even when typed.
    expect(buildNewPlanPayload(FORM, ['sign.storage_bytes', 'sign.team_collaboration']).payload?.allowances).toEqual([]);
  });

  it('PC-W-5 the summary, the pending line, the requester-only apply hint and the inbox rows', () => {
    const p = buildNewPlanPayload(FORM, AVAILABLE).payload!;
    expect(newPlanSummary(p)).toEqual([
      { field: 'Plan', value: 'Team (aramo-sign-team-v2)' },
      { field: 'For', value: 'Business organizations' },
      { field: 'Price', value: '$15 / month' },
      { field: 'Envelopes per month', value: '100' },
      { field: 'Storage', value: '10 GB' },
      { field: 'Features', value: 'Team collaboration' },
    ]);
    expect(pendingPlanCreateLine({ name: 'Team', plan_key: 'aramo-sign-team-v2', state: 'APPROVED' })).toBe('Team (aramo-sign-team-v2) · approved, waiting to be applied');
    expect(planCreateApplyable({ state: 'APPROVED', requested_by: 'u1' }, 'u1')).toBe(true);
    expect(planCreateApplyable({ state: 'APPROVED', requested_by: 'u2' }, 'u1')).toBe(false);
    expect(planCreateApplyable({ state: 'PENDING_APPROVAL', requested_by: 'u1' }, 'u1')).toBe(false);
    const rows = planCreateEffectRows(p as unknown as Record<string, unknown>);
    expect(rows.map((r) => [r.field, r.after])).toEqual([
      ['Plan', 'Team (aramo-sign-team-v2)'],
      ['Product', 'Aramo Sign'],
      ['For', 'Business organizations'],
      ['Sales channel', 'SELF_SERVICE'],
      ['Price', '$15 / month'],
      ['Envelopes per month', '100'],
      ['Storage', '10 GB'],
      ['Features', 'sign.team_collaboration'],
    ]);
    expect(rows.every((r) => r.before === null)).toBe(true);
  });

  it('PC-W-6 the inbox summary names the plan', () => {
    const r = { action_type: 'PLAN_CREATE', product_key: null, payload: { name: 'Team', plan_key: 'aramo-sign-team-v2' } } as unknown as Parameters<typeof summaryOf>[0];
    expect(summaryOf(r, { user_id: 'u1' } as unknown as Parameters<typeof summaryOf>[1])).toBe('Create plan Team (aramo-sign-team-v2)');
  });
});
