import { describe, expect, it, vi } from 'vitest';

import { SignSignupService, SignupBudget } from '../app/signup/sign-signup.service.js';

// Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) §2 (supersedes Signup A1
// "Organization Details US Only") — Business signup accepts a country whose billing region is ON with its
// Business switch ON. India while OFF (the seed) is refused exactly as before, before anything is claimed;
// once ON its organization details are validated with the Indian rules. The US is unchanged.

const INDIA = {
  legal_name: 'Manjal Trading Pvt Ltd',
  address_line1: '12 Anna Salai',
  city: 'Chennai',
  state_province: 'Tamil Nadu',
  postal_code: '600002',
  country_code: 'IN',
  primary_contact_email: 'billing@manjal.co.in',
  primary_contact_name: 'Pat Owner',
  signer_title: 'Director',
  authority_attested: true,
};
const US = { ...INDIA, address_line1: '1 Main St', city: 'Austin', state_province: 'TX', postal_code: '78701', country_code: 'US' };

function service(region: { enabled: boolean; business_web_enabled: boolean } | null | undefined) {
  const requests = {
    findByTokenHash: vi.fn(async () => ({ id: 'req-1', status: 'PENDING', email: 'owner@manjal.co.in', organization_name: 'Manjal', expires_at: new Date(Date.now() + 3_600_000), created_at: new Date() })),
    // The claim is the first write after validation: losing it answers PROVISIONING (nothing created here).
    claim: vi.fn(async () => false),
  };
  const billingRegions = region === undefined ? undefined : { get: vi.fn(async () => (region === null ? null : { country: 'IN', gateway: 'RAZORPAY', currency: 'INR', ...region })) };
  const svc = new SignSignupService(
    requests as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new SignupBudget(), {} as never, {} as never, [], billingRegions as never,
  );
  const complete = (organization: unknown) => svc.complete({ token: 'x'.repeat(40), organization, ip: '203.0.113.9', request_id: 'r' });
  return { complete, requests, billingRegions };
}

const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: { context?: { details?: { reason?: string } } }) => e.context?.details?.reason ?? String(e));

describe('India Billing §2 — Business signup by billing region', () => {
  it('HALT §8 — India OFF (or no region, or no region store): refused organization_country_not_supported before any claim', async () => {
    for (const r of [{ enabled: false, business_web_enabled: false }, { enabled: true, business_web_enabled: false }, { enabled: false, business_web_enabled: true }, null, undefined]) {
      const s = service(r);
      expect(await reason(s.complete(INDIA))).toBe('organization_country_not_supported');
      expect(s.requests.claim).not.toHaveBeenCalled();
    }
  });

  it('India ON (region and Business switch): accepted and validated with the Indian rules', async () => {
    const s = service({ enabled: true, business_web_enabled: true });
    expect(await s.complete(INDIA)).toMatchObject({ status: 'PROVISIONING' });
    expect(s.billingRegions?.get).toHaveBeenCalledWith('IN');
    expect(s.requests.claim).toHaveBeenCalledTimes(1);
    expect(await reason(service({ enabled: true, business_web_enabled: true }).complete({ ...INDIA, postal_code: '78701' }))).toBe('organization_details_invalid');
  });

  it('the US is unchanged and never reads the region store; any other country is refused', async () => {
    const s = service({ enabled: true, business_web_enabled: true });
    expect(await s.complete(US)).toMatchObject({ status: 'PROVISIONING' });
    expect(s.billingRegions?.get).not.toHaveBeenCalled();
    expect(await reason(service({ enabled: true, business_web_enabled: true }).complete({ ...INDIA, country_code: 'GB' }))).toBe('organization_country_not_supported');
  });
});
