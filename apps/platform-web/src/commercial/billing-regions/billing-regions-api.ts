import { apiClient } from '@aramo/fe-foundation';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10, ruling Q3 — the Billing regions page's
// platform-admin calls: the region read (platform:catalog:read) and the governed change (a
// BILLING_REGION_CHANGE change request on the shared route, requester scope platform:catalog:draft, chain
// Finance; created then submitted, as the catalog requests are). Applied by its requester from Approvals.

export type BillingGateway = 'STRIPE' | 'RAZORPAY';
export type PriceTaxMode = 'UNSET' | 'INCLUSIVE' | 'EXCLUSIVE';
export type RegionEnableRefusal = 'gateway_not_configured' | 'selling_entity_inactive' | 'price_tax_mode_unset';

export interface BillingRegion {
  country: string;
  gateway: BillingGateway;
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: PriceTaxMode;
  selling_entity: { id: string; key: string; display_name: string; legal_name: string; country: string; active: boolean };
  gateway_configured: boolean;
  enable_refusal: RegionEnableRefusal | null;
  registration: Record<string, string>;
  open_requests: { id: string; state: string; requested_by: string; created_at: string; expires_at: string | null }[];
}

/** The BILLING_REGION_CHANGE payload: the country and only the fields that change. */
export interface BillingRegionChange {
  country: string;
  enabled?: boolean;
  personal_web_enabled?: boolean;
  business_web_enabled?: boolean;
  price_tax_mode?: PriceTaxMode;
  selling_entity?: { display_name?: string; legal_name?: string; active?: boolean; registration?: Record<string, string> };
}

export interface RegionChangeRequest {
  id: string;
  action_type: string;
  state: string;
}

const REGIONS = '/platform/commercial/billing-regions';
const CR = '/platform/commercial/change-requests';

export const billingRegionsApi = {
  async list(): Promise<BillingRegion[]> {
    const out = await apiClient.get<{ regions: BillingRegion[] }>(REGIONS);
    return out.regions;
  },
  async requestChange(input: { change: BillingRegionChange; reason: string; idempotency_key: string }): Promise<RegionChangeRequest> {
    const created = await apiClient.post<{ request: RegionChangeRequest }>(CR, {
      action_type: 'BILLING_REGION_CHANGE',
      payload: input.change,
      reason: input.reason.trim(),
      idempotency_key: input.idempotency_key,
    });
    const submitted = await apiClient.post<{ request: RegionChangeRequest }>(`${CR}/${encodeURIComponent(created.request.id)}/submit`);
    return submitted.request;
  },
};
