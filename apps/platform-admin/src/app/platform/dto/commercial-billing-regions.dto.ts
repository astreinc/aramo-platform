// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10 — the response shapes of
// Commercial › Billing regions (GET /platform/commercial/billing-regions). Read-only: a
// change is a BILLING_REGION_CHANGE change request on the shared change-request route.

export interface SellingEntityDto {
  id: string;
  key: string;
  display_name: string;
  legal_name: string;
  country: string;
  active: boolean;
}

export interface BillingRegionDto {
  country: string;
  gateway: 'STRIPE' | 'RAZORPAY';
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: 'UNSET' | 'INCLUSIVE' | 'EXCLUSIVE';
  selling_entity: SellingEntityDto;
  /** G-2 — the gateway's credentials are set on the server. */
  gateway_configured: boolean;
  /** G-3 — why the region could not be switched ON now (null: it could). */
  enable_refusal: 'gateway_not_configured' | 'selling_entity_inactive' | 'price_tax_mode_unset' | null;
  /** §5 — the selling entity's registration identifiers (data only; never logged, never shown to tenants). */
  registration: Record<string, string>;
  /** The open BILLING_REGION_CHANGE requests of the region (newest first). */
  open_requests: BillingRegionOpenRequestDto[];
}

export interface BillingRegionOpenRequestDto {
  id: string;
  state: string;
  requested_by: string;
  created_at: string;
  expires_at: string | null;
}

export interface BillingRegionListDto {
  regions: BillingRegionDto[];
}
