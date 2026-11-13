import { Injectable, Optional } from '@nestjs/common';
import { PersonalSignupRepository, TenantRepository } from '@aramo/identity';
import type { BillingCountryPort } from '@aramo/subscription';

// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.4, ruling Q6 — the routing country
// of an account, read from identity (the subscription library never imports identity; this adapter is
// bound in sign-service to BILLING_COUNTRY_PORT):
//   PERSONAL — the declared residence of the tenant's latest PROVISIONED Personal signup;
//   BUSINESS — the organization's registered country (identity Tenant.country_code).
// Anything else (no tenant, no signup, a blank or malformed country) is null: the region lookup then
// refuses (fail closed).

const ISO2 = /^[A-Z]{2}$/;

function iso2(v: string | null | undefined): string | null {
  const c = (v ?? '').trim().toUpperCase();
  return ISO2.test(c) ? c : null;
}

@Injectable()
export class BillingCountryAdapter implements BillingCountryPort {
  constructor(
    private readonly tenants: TenantRepository,
    // Unbound only in unit specs: a Personal tenant then has no residence (null).
    @Optional() private readonly signups?: PersonalSignupRepository,
  ) {}

  async countryOf(tenant_id: string): Promise<{ tenant_kind: 'PERSONAL' | 'BUSINESS' | null; country: string | null }> {
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null) return { tenant_kind: null, country: null };
    if (tenant.kind === 'PERSONAL') {
      const residence = this.signups === undefined || this.signups === null ? null : await this.signups.declaredResidenceOf(tenant_id);
      return { tenant_kind: 'PERSONAL', country: iso2(residence) };
    }
    const profile = await this.tenants.findProfileById(tenant_id);
    return { tenant_kind: 'BUSINESS', country: iso2(profile?.country_code) };
  }
}
