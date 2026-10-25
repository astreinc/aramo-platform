import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { COMMERCIAL_ALERT_STATUSES, commercialAlertTypesOf, type CommercialAlertStatus } from '@aramo/subscription';

// CCP-D3 — GET /platform/commercial/alerts/{billing,approvals} and
// GET /platform/commercial/metrics/{billing,approvals}. READ-ONLY. The query DTOs are the 400-shape
// gate; the alert type is validated against the route's family.

export class BillingAlertQueryDto {
  @IsOptional() @IsIn([...COMMERCIAL_ALERT_STATUSES]) status?: CommercialAlertStatus;
  @IsOptional() @IsIn(commercialAlertTypesOf('BILLING')) alert_type?: string;
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export class ApprovalAlertQueryDto {
  @IsOptional() @IsIn([...COMMERCIAL_ALERT_STATUSES]) status?: CommercialAlertStatus;
  @IsOptional() @IsIn(commercialAlertTypesOf('APPROVAL')) alert_type?: string;
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

/** The metrics routes take no parameter: any query parameter is refused (400, forbidNonWhitelisted). */
export class OperationsMetricsQueryDto {}

export interface CommercialAlertDto {
  id: string;
  alert_type: string;
  // BILLING | APPROVAL
  family: string;
  // billing_command | reconciliation_flag | webhook_inbox | usage_metric | change_request
  subject_kind: string;
  subject_id: string;
  tenant_id: string | null;
  product_key: string | null;
  // OPEN | RESOLVED
  status: string;
  detail: string;
  evidence: Record<string, unknown>;
  threshold_minutes: number | null;
  detection_count: number;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  resolution_detail: string | null;
}

export interface CommercialAlertListResponseDto {
  alerts: CommercialAlertDto[];
  next_cursor: string | null;
}

export interface CommercialAlertThresholdsDto {
  pending_provider_stuck_minutes: number;
  approval_expiry_lead_minutes: number;
}

export interface BillingOperationsMetricsDto {
  as_of: string;
  commands_by_state: Record<string, number>;
  commands_pending_provider_past_threshold: number;
  webhook_inbox_by_status: Record<string, number>;
  open_reconciliation_flags_by_reason: Record<string, number>;
  open_alerts_by_type: Record<string, number>;
  thresholds: CommercialAlertThresholdsDto;
}

export interface ApprovalOperationsMetricsDto {
  as_of: string;
  change_requests_by_state: Record<string, number>;
  pending_approval_nearing_expiry: number;
  pending_approval_past_expiry: number;
  open_alerts_by_type: Record<string, number>;
  thresholds: CommercialAlertThresholdsDto;
}
