import { Type } from 'class-transformer';
import { IsBoolean, IsISO8601, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

// CCP-B5 — the policy screen, the operator roster and the audit export. The DTOs are the
// 400-shape gate; the subscription services are the authority (author role, draft lock,
// policy parser and ranges, export bound).

/** POST /platform/commercial/policy-versions — a DRAFT copied from a version. */
export class CreatePolicyDraftDto {
  @IsUUID() source_version_id!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** The editable settings of a format-1 policy document (integers; the service bounds them). */
export class PolicyDraftContentPatchDto {
  @IsOptional() @IsInt() discount_escalation_threshold_bps?: number;
  @IsOptional() @IsInt() credit_escalation_threshold_minor?: number;
  @IsOptional() @IsInt() support_extension_max_days?: number;
  @IsOptional() @IsInt() support_extension_frequency_window_days?: number;
  @IsOptional() @IsInt() support_extension_cumulative_max_days?: number;
  @IsOptional() @IsInt() support_extension_cumulative_window_days?: number;
  @IsOptional() @IsInt() approval_expiry_hours?: number;
  @IsOptional() @IsInt() past_due_grace_days?: number;
}

/** PATCH /platform/commercial/policy-versions/:id — edit a DRAFT. */
export class UpdatePolicyDraftDto {
  @IsOptional() @IsObject() @ValidateNested() @Type(() => PolicyDraftContentPatchDto) content?: PolicyDraftContentPatchDto;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** POST /platform/commercial/audit-events/export — the A2 filters plus the B5 ones. */
export class CommercialAuditExportDto {
  @IsOptional() @IsUUID() actor_id?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{2,99}$/) event_type?: string;
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsBoolean() exception_only?: boolean;
  @IsOptional() @IsUUID() change_request_id?: string;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{0,39}$/) product_key?: string;
}

export interface CommercialPolicyContentDto {
  format_version: number;
  currency: string;
  discount_escalation_threshold_bps: number;
  credit_escalation_threshold_minor: number;
  support_extension_max_days: number;
  support_extension_frequency_window_days: number;
  support_extension_cumulative_max_days: number;
  support_extension_cumulative_window_days: number;
  approval_expiry_hours: number;
  past_due_grace_days: number;
}

export interface CommercialPolicyVersionDto {
  id: string;
  version_number: number;
  status: string;
  /** null when the stored document fails the strict parser (shown as unavailable). */
  content: CommercialPolicyContentDto | null;
  content_checksum: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  activated_by: string | null;
  activated_at: string | null;
  retired_at: string | null;
  open_request: { id: string; state: string } | null;
}

export interface CommercialPolicyListDto {
  versions: CommercialPolicyVersionDto[];
  active_version_id: string | null;
  open_request: { id: string; state: string; policy_version_id: string } | null;
  caller: { can_author: boolean; can_request_activation: boolean };
}

export interface CommercialRosterOperatorDto {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role_keys: string[];
  commercial_role_keys: string[];
  attested: boolean;
  is_last_owner: boolean;
  pending_role_requests: Array<{ id: string; action_type: string; role_key: string; state: string }>;
}

export interface CommercialChainDto {
  key: string;
  rule: string;
  maker_roles: string[];
  step_roles: string[];
  fulfillable: boolean;
  missing: 'maker' | 'steps' | null;
  unfillable_steps: number[];
}

export interface CommercialRosterDto {
  operators: CommercialRosterOperatorDto[];
  chains: CommercialChainDto[];
  all_fulfillable: boolean;
}

export interface CommercialAuditExportResponseDto {
  export_id: string;
  exported_at: string;
  row_count: number;
  filename: string;
  content_type: 'text/csv';
  csv: string;
  csv_sha256: string;
}
