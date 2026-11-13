// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.4, ruling Q6 — the routing country of
// an account. Declared here (WS-A); bound by the composing service (sign-service, WS-D).

export const BILLING_COUNTRY_PORT = Symbol('BILLING_COUNTRY_PORT');
export interface BillingCountryPort {
  /** Personal: declared_residence of the latest PROVISIONED signup. Business: identity Tenant.country_code. */
  countryOf(tenant_id: string): Promise<{ tenant_kind: 'PERSONAL' | 'BUSINESS' | null; country: string | null }>;
}
