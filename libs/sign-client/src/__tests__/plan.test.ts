// Client Rule Consolidation C3 — runs under vitest and mobile Jest (globals only).
// Audit rows 14–17: templates access once; per-recipient options; plan facts only from the server; "documents".
import {
  ARRANGED_PURCHASE_BLOCKED,
  allowanceTermsLine,
  arrangedPlanLabel,
  arrangedPurchaseRefusal,
  isArrangedPlan,
  isDailyAllowance,
  limitReachedCopy,
  messagingOffered,
  planFacts,
  sendFeaturesOf,
  storageLabel,
  templateAccess,
} from '../index.js';

const ctx = (o: Record<string, unknown> = {}) => ({
  features: { templates: true },
  permissions: { templates: true },
  template_plan: 'INCLUDED',
  template_studio: true,
  ...o,
});

describe('templates access (row 14)', () => {
  it.each([
    ['all on', ctx(), 'ok', 'ok'],
    ['feature off', ctx({ features: { templates: false } }), 'unavailable', 'unavailable'],
    ['no context', null, 'unavailable', 'unavailable'],
    ['plan excludes templates', ctx({ template_plan: 'UPGRADE_REQUIRED' }), 'upgrade', 'upgrade'],
    ['plan not read (null)', ctx({ template_plan: null }), 'ok', 'ok'],
    ['plan absent', ctx({ template_plan: undefined }), 'ok', 'ok'],
    ['no template permission', ctx({ permissions: { templates: false } }), 'no-permission', 'no-permission'],
    ['no studio grant', ctx({ template_studio: false }), 'ok', 'no-permission'],
  ])('%s → use %s, studio %s', (_n, c, use, studio) => {
    expect(templateAccess(c, 'use')).toBe(use);
    expect(templateAccess(c, 'studio')).toBe(studio);
  });
});

describe('per-recipient send options (row 15)', () => {
  it.each([
    ['witness_signing', 'witness'],
    ['delegate_signing', 'delegation'],
    ['access_code', 'accessCode'],
    ['sms_delivery', 'sms'],
    ['whatsapp_delivery', 'whatsapp'],
    ['sms_otp', 'smsCode'],
    ['email_otp', 'emailCode'],
    ['id_verification', 'idCheck'],
    ['kba', 'kba'],
  ] as const)('features.%s → %s', (key, option) => {
    expect(sendFeaturesOf({ features: { [key]: true } })[option]).toBe(true);
    expect(sendFeaturesOf({ features: { [key]: 'true' } })[option]).toBe(false);
    expect(sendFeaturesOf(null)[option]).toBe(false);
  });
  it('messaging is offered with any text option', () => {
    expect(messagingOffered(sendFeaturesOf({ features: { sms_otp: true } }))).toBe(true);
    expect(messagingOffered(sendFeaturesOf({ features: { kba: true } }))).toBe(false);
  });
});

describe('plan facts come from the catalog only (row 16)', () => {
  it.each([
    ['no plan', null, { monthlyDocuments: null, storageBytes: null, templates: null }],
    [
      'Free-like',
      { allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 5, unlimited: false, available: true }], capacities: [{ capacity_key: 'sign.storage_bytes', limit: 15 * 1024 ** 2, unlimited: false }] },
      { monthlyDocuments: 5, storageBytes: 15 * 1024 ** 2, templates: false },
    ],
    [
      'unlimited with templates',
      { allowances: [{ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true }], capacities: [{ capacity_key: 'sign.templates', limit: null, unlimited: true }, { capacity_key: 'sign.storage_bytes', limit: null, unlimited: true }] },
      { monthlyDocuments: 'unlimited', storageBytes: 'unlimited', templates: true },
    ],
    [
      'an unavailable allowance is not advertised',
      { allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 25, unlimited: false, available: false }], capacities: [] },
      { monthlyDocuments: null, storageBytes: null, templates: false },
    ],
  ])('%s', (_n, plan, facts) => {
    expect(planFacts(plan)).toEqual(facts);
  });

  it.each([
    [15 * 1024 ** 2, '15 MB'],
    [1024 ** 3, '1 GB'],
    [512 * 1024, '512 KB'],
  ])('storageLabel(%d) → %s', (b, label) => {
    expect(storageLabel(b)).toBe(label);
  });

  it.each([
    [{ monthly: 5, daily: 2, storageBytes: 15 * 1024 ** 2, templates: false }, '5 documents a month, up to 2 a day · 15 MB storage · templates aren’t included'],
    [{ monthly: 25 }, '25 documents a month'],
    [{ daily: 2 }, 'up to 2 a day'],
    [{}, ''],
    [{ monthly: null, storageBytes: null, templates: null }, ''],
  ])('allowanceTermsLine %j', (input, line) => {
    expect(allowanceTermsLine(input)).toBe(line);
  });
});

describe('limit reached says "documents" (row 17, Appendix A)', () => {
  it.each([
    ['monthly', 5, 'Nov 30', 'Monthly limit reached', 'You’ve used all 5 documents this month. Your allowance resets on Nov 30.'],
    ['monthly', null, null, 'Monthly limit reached', 'You’ve used all your documents this month.'],
    ['daily', 2, '9:14 AM', 'Daily limit reached', 'You’ve sent 2 documents in the last 24 hours, the most your plan allows. You can send again at 9:14 AM.'],
    ['daily', null, null, 'Daily limit reached', 'You’ve sent the most documents your plan allows in 24 hours.'],
  ] as const)('%s %j %j', (kind, limit, at, title, body) => {
    expect(limitReachedCopy(kind, limit, at)).toEqual({ kind, title, body });
  });

  it.each([
    [{ reason: 'DAILY_LIMIT_REACHED' }, true],
    [{ window: 'DAY' }, true],
    [{ reason: 'LIMIT_REACHED' }, false],
    [null, false],
  ])('isDailyAllowance %j', (d, daily) => {
    expect(isDailyAllowance(d)).toBe(daily);
  });
});

// CCP-PERSONAL-ARRANGED-1 P-7 / D-8 — one copy for a plan arranged with Aramo (web and the app).
describe('a plan arranged with Aramo (P-7)', () => {
  const acct = (sub: Record<string, unknown> | null) => ({ subscription: sub });

  it('the label carries the plan name', () => {
    expect(arrangedPlanLabel('Standard')).toBe('Standard · arranged with Aramo');
    expect(arrangedPlanLabel(' Standard ')).toBe('Standard · arranged with Aramo');
    expect(arrangedPlanLabel(null)).toBe('Arranged with Aramo');
    expect(arrangedPlanLabel('')).toBe('Arranged with Aramo');
  });

  it.each([
    ['arranged, open', acct({ arranged: true, ended_at: null }), true],
    ['arranged, ended_at absent', acct({ arranged: true }), true],
    ['arranged, ended', acct({ arranged: true, ended_at: '2026-11-24T00:00:00.000Z' }), false],
    ['not arranged', acct({ arranged: false, ended_at: null }), false],
    ['older server (no flag)', acct({ ended_at: null }), false],
    ['no subscription', acct(null), false],
    ['no account', null, false],
  ])('isArrangedPlan: %s', (_n, a, out) => {
    expect(isArrangedPlan(a)).toBe(out);
  });

  it('a managed-plan purchase refusal on an arranged plan says it is arranged with Aramo', () => {
    const arranged = acct({ arranged: true, ended_at: null });
    expect(ARRANGED_PURCHASE_BLOCKED).toBe('Your plan is arranged with Aramo. Contact support to change it.');
    expect(arrangedPurchaseRefusal(arranged, 'billing_managed_elsewhere')).toBe(ARRANGED_PURCHASE_BLOCKED);
    expect(arrangedPurchaseRefusal(arranged, 'governed_subscription_open')).toBe(ARRANGED_PURCHASE_BLOCKED);
    expect(arrangedPurchaseRefusal(arranged, 'not_billing_manager')).toBeNull();
    expect(arrangedPurchaseRefusal(arranged, null)).toBeNull();
    expect(arrangedPurchaseRefusal(acct({ arranged: false, ended_at: null }), 'billing_managed_elsewhere')).toBeNull();
  });
});
