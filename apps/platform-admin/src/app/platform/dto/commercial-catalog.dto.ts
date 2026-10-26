import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

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

export class UpdateCatalogDraftDto {
  @IsString() @Matches(/^[0-9a-f]{64}$/) expected_content_checksum!: string;
  /** Minor units (USD cents). */
  @ValidateIf((o: UpdateCatalogDraftDto) => o.list_price_minor !== undefined) @IsInt() @Min(0) @Max(100_000_000) list_price_minor?: number;
  /** null = unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) envelopes_per_month?: number | null;
  /** Binary bytes; null = unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) storage_bytes?: number | null;
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
  sales_model: string;
  sellable: boolean;
  display_order: number;
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
}

export interface CatalogVersionDetailDto {
  version: CatalogVersionSummaryDto;
  plan: CatalogPlanDto;
  content: Record<string, unknown>;
  pinned_tenants: { tenant_id: string; name: string }[];
}
