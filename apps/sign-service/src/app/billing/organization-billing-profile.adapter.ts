import { Injectable, Logger, Optional } from '@nestjs/common';
import { BILLING_REGION_US, DomainClaimService, OrganizationRegionService, TenantRepository, organizationProfileIneligibility } from '@aramo/identity';
import { BillingRegionService, type OrganizationBillingProfile, type OrganizationBillingProfilePort, type OrganizationProfileRefusal } from '@aramo/subscription';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 (Organization Details, US only;
// LOCKED) §2.6 — the organization billing profile, read from the identity tenant
// profile (the registered organization address, refinement B item 1). Eligible
// only when US, 50 states + DC, and the required fields are present (the same
// rule the signup form and the profile lock use). Checkout locks the tenant's
// profile to the US (§2.5).
//
// India Billing Regions + Razorpay (directive v1.0 §2, §4.9) — a non-US organization (India) is eligible
// only while its billing region sells to BUSINESS (region and Business switches ON, gateway configured);
// the US rule above is unchanged. Checkout then holds the profile to the routed region.
//
// Domain-Enforcement P3 §4 (sending gate, ruling 5) — the tenant's email-domain
// claim must be AUTHORITATIVE for a new self-service subscription. No binding or
// a failed lookup is NOT authoritative (fail closed).
@Injectable()
export class OrganizationBillingProfileAdapter implements OrganizationBillingProfilePort {
  private readonly log = new Logger(OrganizationBillingProfileAdapter.name);

  constructor(
    private readonly tenants: TenantRepository,
    private readonly regions: OrganizationRegionService,
    @Optional() private readonly domainClaims?: DomainClaimService,
    // India Billing — the billing region store (SubscriptionModule). Unbound: US only (fail closed).
    @Optional() private readonly billingRegions?: BillingRegionService,
  ) {}

  /** Whether a non-US country sells to BUSINESS now (fail closed). */
  private async businessCountryOpen(country: string | null): Promise<boolean> {
    if (country === null || this.billingRegions === undefined || this.billingRegions === null) return false;
    try {
      return (await this.billingRegions.sellable(country, 'BUSINESS')).ok;
    } catch (e) {
      this.log.warn(`billing region lookup failed for ${country}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async eligibleProfile(tenant_id: string): Promise<{ profile: OrganizationBillingProfile } | { refused: OrganizationProfileRefusal }> {
    const p = await this.tenants.findProfileById(tenant_id);
    if (p === null) return { refused: 'organization_profile_incomplete' };
    const country = p.country_code?.trim().toUpperCase() ?? null;
    const open = country !== null && country !== '' && country !== BILLING_REGION_US ? await this.businessCountryOpen(country) : false;
    const refused = organizationProfileIneligibility(p, (c) => c === country && open);
    if (refused !== null) return { refused };
    // organizationProfileIneligibility guarantees every required field below is present.
    const v = (x: string | null): string => (x ?? '').trim();
    return {
      profile: {
        legal_name: v(p.legal_name),
        billing_email: v(p.primary_contact_email),
        address: {
          line1: v(p.address_line1),
          line2: v(p.address_line2) === '' ? null : v(p.address_line2),
          city: v(p.city),
          state: v(p.state_province).toUpperCase(),
          postal_code: v(p.postal_code),
          country: v(p.country_code).toUpperCase(),
        },
      },
    };
  }

  async lockRegion(tenant_id: string, region?: string): Promise<void> {
    if (region === undefined || region.toUpperCase() === BILLING_REGION_US) await this.regions.lockUs(tenant_id);
    else await this.regions.lock(tenant_id, region);
  }

  async domainAuthoritative(tenant_id: string): Promise<boolean> {
    if (this.domainClaims === undefined || this.domainClaims === null) return false;
    try {
      return (await this.domainClaims.isAuthoritative(tenant_id)) === true;
    } catch (e) {
      this.log.warn(`domain claim lookup failed for ${tenant_id}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
