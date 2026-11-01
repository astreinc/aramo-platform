import { type PlanCreatePayload } from '../../lib/commercial/commercial-plan-create.js';

// CCP PLAN_CREATE — the shared valid payload of the unit and integration specs (one helper, not two copies).

export const VALID: PlanCreatePayload = {
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
  capacities: [{ capacity_key: 'sign.storage_bytes', limit_quantity: 10737418240, unlimited: false }],
  features: [
    { feature_key: 'sign.team_collaboration', enabled: true },
    { feature_key: 'sign.in_person_signing', enabled: false },
  ],
};
