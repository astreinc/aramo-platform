// Aramo-Sign-Signup-Federated-Owner Amendment A1 (Organization Details, US only;
// LOCKED) §2.6 — self-service checkout needs an ELIGIBLE organization profile
// (US, 50 states + DC, required fields present). The organization profile lives
// outside the subscription library; the composing service binds this port. With
// no binding every checkout is refused (fail closed) — the library takes no new
// dependency.

export const ORGANIZATION_BILLING_PROFILE_PORT = 'ORGANIZATION_BILLING_PROFILE_PORT';

export type OrganizationProfileRefusal = 'organization_country_not_supported' | 'organization_profile_incomplete';

export interface OrganizationBillingAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export interface OrganizationBillingProfile {
  legal_name: string;
  billing_email: string;
  address: OrganizationBillingAddress;
}

export interface OrganizationBillingProfilePort {
  eligibleProfile(tenant_id: string): Promise<{ profile: OrganizationBillingProfile } | { refused: OrganizationProfileRefusal }>;
  /** Hold the tenant's organization profile to the US (idempotent). */
  lockRegion(tenant_id: string): Promise<void>;
  /**
   * Domain-Enforcement P3 §4 (sending gate, ruling 5) — true only when the
   * tenant's email-domain claim is AUTHORITATIVE. A new self-service
   * subscription needs it at checkout start and at activation. Fail closed: any
   * doubt (no claim, no binding) is false.
   */
  domainAuthoritative(tenant_id: string): Promise<boolean>;
}
