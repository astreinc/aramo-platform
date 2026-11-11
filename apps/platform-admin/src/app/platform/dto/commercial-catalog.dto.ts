import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateBy, ValidateIf } from 'class-validator';
import { billingProductsShapeErrors } from '@aramo/subscription';

/**
 * The 8-4-4-4-12 hex SHAPE of a uuid, without the RFC 9562 version/variant check: the CCP-A5
 * v1 backfill derives version ids from md5 (`md5('ccp-a5-plan-version-v1:' || plan_id)::uuid`),
 * which Postgres accepts but `IsUUID` / `ParseUUIDPipe` refuse (TD-B2-4).
 */
export const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// CCP-B2 — /platform/commercial/catalog. The DTOs are the 400-shape gate; the
// CommercialCatalogService is the authority for the draft rules (DRAFT only, one DRAFT per
// plan, the editable terms, contract pricing). There is deliberately no field for the
// currency, the billing interval (the v1 locks), the plan identity or any new term key.

export class CreateCatalogDraftDto {
  @IsString() @Matches(UUID_SHAPE, { message: 'from_version_id must be a uuid' }) from_version_id!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** A4 D2 — the unit-price edit map: metered unit key → minor units (0..10,000,000) or null (not sold). */
export const UNIT_PRICE_EDIT_KEY = /^[a-z]+\.[a-z][a-z0-9_]{1,62}$/;
export const MAX_UNIT_PRICE_EDITS = 20;
export function isUnitPriceEditMap(v: unknown): v is Record<string, number | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > MAX_UNIT_PRICE_EDITS) return false;
  return entries.every(([k, p]) => UNIT_PRICE_EDIT_KEY.test(k) && (p === null || (typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 && p <= 10_000_000)));
}

/** M-A12 A1-3 — the regional-price edit list: (country, interval) → currency + minor units, or null (remove). */
export const MAX_REGIONAL_PRICE_EDITS = 50;
export function isRegionalPriceEditList(v: unknown): v is { country: string; interval: 'MONTH' | 'YEAR'; currency: string; amount_minor: number | null }[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REGIONAL_PRICE_EDITS) return false;
  return v.every((e) => {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
    const o = e as Record<string, unknown>;
    if (Object.keys(o).some((k) => !['country', 'interval', 'currency', 'amount_minor'].includes(k))) return false;
    return (
      typeof o['country'] === 'string' &&
      /^[A-Z]{2}$/.test(o['country']) &&
      o['country'] !== 'US' &&
      (o['interval'] === 'MONTH' || o['interval'] === 'YEAR') &&
      typeof o['currency'] === 'string' &&
      /^[A-Z]{3}$/.test(o['currency']) &&
      (o['amount_minor'] === null || (typeof o['amount_minor'] === 'number' && Number.isSafeInteger(o['amount_minor']) && o['amount_minor'] >= 0 && o['amount_minor'] <= 1_000_000_000))
    );
  });
}

export class UpdateCatalogDraftDto {
  @IsString() @Matches(/^[0-9a-f]{64}$/) expected_content_checksum!: string;
  /** Minor units (USD cents). */
  @ValidateIf((o: UpdateCatalogDraftDto) => o.list_price_minor !== undefined) @IsInt() @Min(0) @Max(100_000_000) list_price_minor?: number;
  /** null = unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) envelopes_per_month?: number | null;
  /** Binary bytes; null = unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) storage_bytes?: number | null;
  /** A4 D2 — add-on unit prices: unit key → minor units (USD cents), or null to stop selling the unit. */
  @IsOptional()
  @IsObject()
  @ValidateBy({ name: 'isUnitPriceEditMap', validator: { validate: (v: unknown) => isUnitPriceEditMap(v), defaultMessage: () => 'unit_prices must map 1..20 metered unit keys to an integer 0..10000000 or null' } })
  unit_prices?: Record<string, number | null>;
  /**
   * M-A12 A1-3 — regional list prices (e.g. IN / INR): each entry sets the (country, interval) price in
   * the currency's minor units, or removes it (amount_minor null). Never US (the list price is US/USD).
   */
  @IsOptional()
  @ValidateBy({
    name: 'isRegionalPriceEditList',
    validator: {
      validate: (v: unknown) => isRegionalPriceEditList(v),
      defaultMessage: () => 'regional_prices must list 1..50 { country (ISO alpha-2, not US), interval MONTH|YEAR, currency (ISO 4217), amount_minor integer 0..1000000000 or null }',
    },
  })
  regional_prices?: { country: string; interval: 'MONTH' | 'YEAR'; currency: string; amount_minor: number | null }[];
  /** Sign per-seat pricing — SEAT (BUSINESS self-service plans only; else 422 price_unit_not_applicable) or ACCOUNT. */
  @IsOptional() @IsIn(['ACCOUNT', 'SEAT']) price_unit?: 'ACCOUNT' | 'SEAT';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export interface CatalogVersionTermsDto {
  list_price_minor: number | null;
  currency: string | null;
  billing_interval: string | null;
  sales_model: string;
  contract_priced: boolean;
  envelopes_per_month: number | null;
  envelopes_unlimited: boolean;
  envelopes_present: boolean;
  storage_bytes: number | null;
  storage_unlimited: boolean;
  storage_present: boolean;
  /** A3 D1 / A4 D2 — the add-on unit prices on the version (empty = no add-on sold). */
  unit_prices: { unit_key: string; unit_price_minor: number }[];
  /** M-A12 A1-3 — the regional list prices on the version (empty = none). */
  regional_prices: { country: string; currency: string; amount_minor: number; interval: 'MONTH' | 'YEAR' }[];
  /** Sign per-seat pricing — ACCOUNT when the version carries no price_unit. */
  price_unit: 'ACCOUNT' | 'SEAT';
  /** The plan's tenant kind (BUSINESS | PERSONAL | null). */
  tenant_kind: string | null;
}

export interface CatalogOpenRequestDto {
  id: string;
  action_type: string;
  state: string;
  expires_at: string | null;
}

export interface CatalogVersionSummaryDto {
  id: string;
  plan_id: string;
  version_number: number;
  status: string;
  content_checksum: string;
  note: string | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
  retired_at: string | null;
  terms: CatalogVersionTermsDto;
  pinned_subscriptions: number;
  open_requests: CatalogOpenRequestDto[];
}

export interface CatalogPlanDto {
  id: string;
  key: string;
  product_key: string;
  name: string;
  status: string;
  /** BUSINESS | PERSONAL | null — the console offers per-seat pricing only on a BUSINESS self-service plan. */
  tenant_kind: string | null;
  sales_model: string;
  sellable: boolean;
  display_order: number;
}

/** CCP PLAN_CREATE (PC-8) — an open request to create a plan. */
export interface CatalogPendingPlanCreateDto {
  id: string;
  plan_key: string;
  name: string;
  product_key: string;
  tenant_kind: string;
  sales_model: string;
  state: string;
  requested_by: string;
  expires_at: string | null;
}

export interface CatalogResponseDto {
  products: { product_key: string; plans: (CatalogPlanDto & { versions: CatalogVersionSummaryDto[] })[] }[];
  publish_chain: {
    rule: string;
    step_role_keys: string[];
    policy_version_id: string;
    policy_version_number: number;
    approval_expiry_hours: number;
  } | null;
  /** CCP PLAN_CREATE — the capability keys a new plan may name (PC-4) and the pending creations. */
  plan_create: {
    available_keys: { product_key: string; keys: string[] }[];
    pending: CatalogPendingPlanCreateDto[];
  };
  /** A4 D2 — the add-on (metered) units a draft of each product can price. */
  metered_units: { product_key: string; units: { unit_key: string; name: string; quantity_label: string }[] }[];
}

export interface CatalogVersionDetailDto {
  version: CatalogVersionSummaryDto;
  plan: CatalogPlanDto;
  content: Record<string, unknown>;
  pinned_tenants: { tenant_id: string; name: string }[];
  /** CCP Billing Products — the plan's billing products as this version sees them (ids, sync status, link). */
  billing_products: BillingProductViewDto[];
  /** BP-2 — the channels this plan may sell on. */
  billing_eligible: ('STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY')[];
  /** BP-11 — the billing products a publish of this plan starts from (what the plan sells on today). */
  billing_carry_forward: { provider: 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY'; interval: 'MONTH' | 'YEAR'; product_id: string }[];
}

// CCP Billing Products Directive v1.0 (LOCKED) §3.4 — the billing-product routes on this controller.

/** POST versions/:versionId/billing-preview — the products to price (the publish payload's `products`). */
export class BillingPreviewDto {
  @ValidateBy({
    name: 'isBillingProductList',
    validator: { validate: (v: unknown) => Array.isArray(v) && billingProductsShapeErrors({ products: v }).length === 0, defaultMessage: () => 'products must be 0..6 billing products { provider, interval, product_id }' },
  })
  products!: { provider: 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY'; interval: 'MONTH' | 'YEAR'; product_id: string }[];
}

/** POST plans/:planId/billing-assets/apple-review-screenshot — the image as base64 (BP-7). */
export class UploadReviewScreenshotDto {
  @IsString() @MaxLength(100) file_name!: string;
  @IsIn(['image/png', 'image/jpeg']) content_type!: 'image/png' | 'image/jpeg';
  @IsString() @MaxLength(11_200_000) @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'content_base64 must be base64' }) content_base64!: string;
}

export interface BillingProductViewDto {
  provider: 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY';
  interval: 'MONTH' | 'YEAR';
  product_id: string;
  origin: 'CREATED' | 'ADOPTED' | null;
  linked: boolean;
  sync: null | {
    id: string;
    change_request_id: string;
    plan_version_id: string;
    status: 'PENDING' | 'SYNCED' | 'NEEDS_ATTENTION' | 'FAILED' | 'NOT_CONFIGURED';
    attempts: number;
    store_state: string | null;
    last_error: string | null;
    synced_at: string | null;
    next_attempt_at: string;
  };
}
