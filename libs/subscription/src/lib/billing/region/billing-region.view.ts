// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.1, §5, §6 — the billing region read
// model and the governed change (BILLING_REGION_CHANGE, ruling Q3). Types only.

import type { WebBillingProviderKey } from '../billing-provider.port.js';

export type BillingSegment = 'PERSONAL' | 'BUSINESS';

export const PRICE_TAX_MODES = ['UNSET', 'INCLUSIVE', 'EXCLUSIVE'] as const;
/** Whether a configured price already includes tax. Recorded only; nothing computes tax (CCP-C5). */
export type PriceTaxMode = (typeof PRICE_TAX_MODES)[number];

export interface SellingEntityView {
  id: string;
  key: string;
  display_name: string;
  legal_name: string;
  country: string;
  active: boolean;
}

export interface BillingRegionView {
  country: string;
  gateway: WebBillingProviderKey;
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: PriceTaxMode;
  selling_entity: SellingEntityView;
}

export type RegionSellRefusal = 'region_not_supported' | 'region_disabled' | 'segment_disabled' | 'gateway_not_configured';

/** Directive §6 G-3 — why a region may not be switched ON. */
export type RegionEnableRefusal = 'gateway_not_configured' | 'selling_entity_inactive' | 'price_tax_mode_unset';

/** Directive §5 — the named registration identifiers a selling entity may hold (data only). */
export const SELLING_ENTITY_REGISTRATION_KEYS = ['gstin', 'pan', 'state_code', 'place_of_supply_rule', 'note'] as const;
export type SellingEntityRegistrationKey = (typeof SELLING_ENTITY_REGISTRATION_KEYS)[number];

/**
 * The payload of a BILLING_REGION_CHANGE (Q3) and the input of BillingRegionService.applyChange: the
 * region's country and the fields to change. An absent field is unchanged. `selling_entity.registration`
 * replaces the whole registration document.
 */
export interface BillingRegionChange {
  country: string;
  enabled?: boolean;
  personal_web_enabled?: boolean;
  business_web_enabled?: boolean;
  price_tax_mode?: PriceTaxMode;
  selling_entity?: {
    display_name?: string;
    legal_name?: string;
    registration?: Record<string, string>;
    active?: boolean;
  };
}

/** Whether a web gateway's credentials are configured (G-2). */
export type BillingGatewayConfigured = (p: WebBillingProviderKey) => boolean;
/** DI token of the gateway configured-check BillingRegionService uses (absent: every gateway is unconfigured). */
export const BILLING_GATEWAY_CONFIGURED = Symbol('BILLING_GATEWAY_CONFIGURED');
