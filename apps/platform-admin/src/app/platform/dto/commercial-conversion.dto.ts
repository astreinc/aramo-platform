import type { BillingCommandDto } from './commercial-billing.dto.js';
import type { CommercialChangeApplicationDto } from './commercial-change-application.dto.js';

// CCP-C2 — the conversion state of a CONVERSION change request (POST …/{id}/convert,
// GET …/{id}/conversion). `pending_provider` is true while any Stripe-owned operation of the request
// is not provider-confirmed (Conv. C-23; TD-C1-9 for the request).

export interface ConversionReleaseDto {
  id: string;
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  governed_subscription_id: string;
  plan_id: string;
  plan_version_id: string;
  held_subscription_ref: string | null;
  // RELEASED | CONSUMED | CONVERTED | EXPIRED (stored)
  state: string;
  // The state a reader sees: an unconsumed release past its expiry reads EXPIRED.
  effective_state: string;
  expires_at: string;
  intent_id: string | null;
  consumed_at: string | null;
  self_service_subscription_id: string | null;
  converted_at: string | null;
  expired_at: string | null;
  created_by: string;
  created_at: string;
}

export interface ConversionDto {
  // TO_SELF_SERVICE | TO_GOVERNED
  direction: string | null;
  // NOT_APPLIED | APPLY_FAILED | RELEASED | CHECKOUT_STARTED | RELEASE_EXPIRED | CONVERTED | PENDING_PROVIDER | COMPLETED
  status: string;
  pending_provider: boolean;
  release: ConversionReleaseDto | null;
  commands: BillingCommandDto[];
  application: CommercialChangeApplicationDto | null;
}
