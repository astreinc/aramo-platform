import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { PRODUCT_KEYS } from '@aramo/subscription';

import type { CommercialChangeApplicationDto } from './commercial-change-application.dto.js';
import type { CommercialChangeRequestDto } from './commercial-change-request.dto.js';

// CCP-A8 — /platform/commercial/support-extensions. The DTOs are the 400-shape gate; the
// SupportExtensionService is the authority for the requester scope, the bound, eligibility,
// Q14 and idempotency.

export class RequestSupportExtensionDto {
  @IsUUID() tenant_id!: string;
  @IsIn(PRODUCT_KEYS) product_key!: (typeof PRODUCT_KEYS)[number];
  @IsUUID() subscription_id!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(3650) requested_days!: number;
  @IsString() @Length(1, 2000) reason!: string;
  @IsString() @Length(8, 200) @Matches(/^[A-Za-z0-9._:-]+$/) idempotency_key!: string;
}

export class ListSupportExtensionsQueryDto {
  @IsUUID() tenant_id!: string;
  @IsOptional() @IsIn(PRODUCT_KEYS) product_key?: (typeof PRODUCT_KEYS)[number];
}

export interface SupportExtensionDto {
  id: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  change_request_id: string;
  is_exception: boolean;
  days: number;
  grace_until_at_apply: string | null;
  base_until: string;
  extends_until: string;
  policy_version_id: string;
  applied_by: string;
  applied_at: string;
  removed_at: string | null;
  removed_by: string | null;
  remove_change_request_id: string | null;
  /** The overlay keeps the row sending now (unremoved and extends_until in the future). */
  active?: boolean;
  /** CCP-B6 (list route only) — what was recorded when the overlay was applied. */
  context?: {
    policy_version_number: number | null;
    clause: Record<string, number> | null;
    counters: Record<string, number> | null;
    roles_at_apply: string[];
  };
}

/** CCP-B6 — an open base subscription row of the tenant (the POST names one by id). */
export interface SupportExtensionSubscriptionDto {
  id: string;
  product_key: string;
  source: string;
  status: string;
  grace_until: string | null;
  current_period_end: string | null;
}

export interface SupportExtensionListDto {
  extensions: SupportExtensionDto[];
  /** CCP-B6 — the tenant's open base subscription rows (optionally one product). */
  subscriptions: SupportExtensionSubscriptionDto[];
  /** CCP-B6 — the ACTIVE policy's extension clause; null when no valid ACTIVE policy. */
  policy: { version_id: string; version_number: number; clause: Record<string, number>; approval_expiry_hours: number } | null;
}

export interface SupportExtensionDecisionDto {
  within_bounds: boolean;
  breaches: string[];
  eligibility: string[];
  counters: { requested_days: number; extensions_in_frequency_window: number; cumulative_days_before: number; cumulative_days_after: number };
  clause: Record<string, number>;
}

export interface SupportExtensionOutcomeDto {
  /** APPLIED: a bounded EXCEPTION applied now. ESCALATED: a NORMAL request awaits Finance (Q7); nothing applied. */
  outcome: 'APPLIED' | 'ESCALATED';
  replayed: boolean;
  request: CommercialChangeRequestDto;
  extension: SupportExtensionDto | null;
  application: CommercialChangeApplicationDto | null;
  decision: SupportExtensionDecisionDto | null;
}
