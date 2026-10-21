import type {
  OrganizationBillingProfile,
  OrganizationBillingProfilePort,
  OrganizationProfileRefusal,
} from '../../lib/billing/organization-billing-profile.port.js';

// Sign Signup Amendment A1 §2.6 — a test stand-in for the organization billing
// profile port (sign-service binds the real one from the identity profile).

export const US_PROFILE: OrganizationBillingProfile = {
  legal_name: 'Acme Holdings LLC',
  billing_email: 'billing@acme.test',
  address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
};

export class FakeOrganizationBillingProfile implements OrganizationBillingProfilePort {
  refused: OrganizationProfileRefusal | null = null;
  profile: OrganizationBillingProfile = US_PROFILE;
  locked: string[] = [];
  /** P3 §4 — the tenant's domain claim is AUTHORITATIVE (default: yes, as grandfathered). */
  authoritative = true;
  domainChecks: string[] = [];
  async eligibleProfile(): Promise<{ profile: OrganizationBillingProfile } | { refused: OrganizationProfileRefusal }> {
    return this.refused !== null ? { refused: this.refused } : { profile: this.profile };
  }
  async lockRegion(tenant_id: string): Promise<void> {
    this.locked.push(tenant_id);
  }
  async domainAuthoritative(tenant_id: string): Promise<boolean> {
    this.domainChecks.push(tenant_id);
    return this.authoritative;
  }
}
