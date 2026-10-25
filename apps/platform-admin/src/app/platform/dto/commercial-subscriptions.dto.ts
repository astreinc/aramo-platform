import { IsIn, IsOptional } from 'class-validator';
import { PRODUCT_KEYS } from '@aramo/subscription';

import type { TaxAvailabilityDto } from './commercial-billing-status.dto.js';

// CCP-B3 (PBD §5.3 row B3; pre-execution record C-1) — GET /platform/commercial/subscriptions and
// GET /platform/commercial/tenants/{tenant_id}/commercial (platform:subscription:read). The query
// DTO is the 400-shape gate; CommercialSubscriptionReadService (libs/subscription) is the
// authority. Read-only and no money (PLATFORM-UX-1 A1-4a): no price, amount or currency field.

export class CommercialSubscriptionsQueryDto {
  // The CCP-A4 product registry (v1: sign only).
  @IsOptional() @IsIn([...PRODUCT_KEYS]) product_key?: (typeof PRODUCT_KEYS)[number];
}

export interface CommercialSubscriptionSummaryDto {
  subscription_id: string;
  product_key: string;
  plan: { id: string; key: string; name: string; sales_model: string };
  plan_version: { id: string; version_number: number; status: string };
  source: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  period_anchor: string;
  /** The billing period containing as_of; null for an ended row. */
  current_period: { start: string; end: string } | null;
  current_period_end: string | null;
  grace_until: string | null;
  commitment_end: string | null;
  contract: { id: string; contract_ref: string } | null;
  provider_linked: boolean;
  open_flags: string[];
  active_extensions: { count: number; exception: boolean };
}

export interface CommercialWorkbenchRowDto extends CommercialSubscriptionSummaryDto {
  tenant: { id: string; name: string | null; slug: string | null };
}

export interface CommercialSubscriptionsResponseDto {
  as_of: string;
  rows: CommercialWorkbenchRowDto[];
}

export interface CommercialProductEntitlementDto {
  capability: string;
  state: 'ACTIVE' | 'REVOKED' | 'NONE';
  granted_source: string | null;
  granted_at: string | null;
  granted_by: string | null;
  change_request_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_change_request_id: string | null;
}

export interface CommercialTenantFlagDto {
  id: string;
  reason: string;
  provider: string;
  subscription_ref: string;
  intent_id: string | null;
  detected_at: string;
  conversion: { change_request_id: string; state: string; direction: string | null } | null;
}

export interface CommercialTenantOpenRequestDto {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  requested_by: string;
  created_at: string;
}

export interface CommercialTenantProductDto {
  product_key: 'sign' | 'ats' | 'portal' | 'intelligence';
  registered: boolean;
  entitlement: CommercialProductEntitlementDto;
  subscription: CommercialSubscriptionSummaryDto | null;
  flags: CommercialTenantFlagDto[];
  open_request: CommercialTenantOpenRequestDto | null;
}

export interface CommercialTenantOverviewResponseDto {
  as_of: string;
  tenant: { id: string; name: string; slug: string | null; kind: string };
  products: CommercialTenantProductDto[];
  // CCP-C5 — always disabled until Stripe Tax registration.
  tax: TaxAvailabilityDto;
}
