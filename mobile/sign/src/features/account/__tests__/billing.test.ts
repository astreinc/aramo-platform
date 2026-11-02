// Remaining-Work A4 — the account screen links to the web billing settings (Cancel subscription)
// only for someone who may manage billing on a provider-billed plan.
import type { BillingAccount } from '../../inbox/types';
import { BILLING_SETTINGS_URL, MANAGE_BILLING_LABEL, PERSONAL_BILLING_SETTINGS_URL, billingSettingsLink } from '../billing';

function account(over: Partial<BillingAccount> = {}, sub: Partial<NonNullable<BillingAccount['subscription']>> = {}): BillingAccount {
  return {
    subscription: {
      plan_key: 'aramo-sign-standard-business-v1',
      plan_name: 'Business Standard',
      source: 'SELF_SERVICE',
      status: 'ACTIVE',
      sending: true,
      started_at: '2026-11-01T00:00:00Z',
      ended_at: null,
      current_period_end: '2026-12-01T00:00:00Z',
      cancel_at_period_end: false,
      grace_until: null,
      billing_managed: true,
      ...sub,
    },
    tenant_kind: 'BUSINESS',
    can_manage_billing: true,
    ...over,
  } as BillingAccount;
}

describe('billingSettingsLink', () => {
  it('Business and Personal owners of a billed plan get their workspace billing settings', () => {
    expect(MANAGE_BILLING_LABEL).toBe('Manage billing or cancel');
    expect(billingSettingsLink(account())).toBe(BILLING_SETTINGS_URL);
    expect(BILLING_SETTINGS_URL).toMatch(/\/sign\/settings\/billing$/);
    expect(billingSettingsLink(account({ tenant_kind: 'PERSONAL' }))).toBe(PERSONAL_BILLING_SETTINGS_URL);
    expect(PERSONAL_BILLING_SETTINGS_URL).toMatch(/\/personal\/settings\/billing$/);
  });

  it('nothing without billing authority, without a billed plan, or after the plan ended', () => {
    expect(billingSettingsLink(null)).toBeNull();
    expect(billingSettingsLink(account({ can_manage_billing: false }))).toBeNull();
    expect(billingSettingsLink(account({ subscription: null }))).toBeNull();
    expect(billingSettingsLink(account({}, { billing_managed: false, source: 'FREE' }))).toBeNull();
    expect(billingSettingsLink(account({}, { ended_at: '2026-11-15T00:00:00Z' }))).toBeNull();
  });
});
