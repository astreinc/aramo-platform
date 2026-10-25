import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { COMMERCIAL_ACTION_TYPES, COMMERCIAL_CHANGE_REQUEST_KINDS, COMMERCIAL_CHANGE_REQUEST_STATES } from '@aramo/subscription';

// CCP-A3 — /platform/commercial/change-requests. The DTOs are the 400-shape gate; the
// CommercialChangeRequestService is the authority for requester scope, state, Q14,
// idempotency and approval eligibility.

export class CreateCommercialChangeRequestDto {
  @IsIn(COMMERCIAL_ACTION_TYPES) action_type!: (typeof COMMERCIAL_ACTION_TYPES)[number];
  @IsOptional() @IsIn(COMMERCIAL_CHANGE_REQUEST_KINDS) kind?: (typeof COMMERCIAL_CHANGE_REQUEST_KINDS)[number];
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{0,39}$/) product_key?: string;
  @IsObject() payload!: Record<string, unknown>;
  @IsString() @Length(1, 2000) reason!: string;
  @IsString() @Length(8, 200) @Matches(/^[A-Za-z0-9._:-]+$/) idempotency_key!: string;
}

export class ApproveCommercialChangeRequestDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(9) step_index!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class RejectCommercialChangeRequestDto {
  @IsString() @Length(1, 2000) reason!: string;
}

export class ListCommercialChangeRequestsQueryDto {
  @IsOptional() @IsIn(COMMERCIAL_CHANGE_REQUEST_STATES) state?: (typeof COMMERCIAL_CHANGE_REQUEST_STATES)[number];
  // `me` or a user id.
  @IsOptional() @IsString() @Matches(/^(me|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/) requester?: string;
  @IsOptional() @IsIn(['true', 'false']) eligible_for_me?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export interface CommercialChainStepDto {
  step_index: number;
  role_key: string;
  scope_keys: string[];
}

export interface CommercialChangeRequestDto {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  payload_checksum: string;
  required_chain: { rule: string; basis: Record<string, unknown>; steps: CommercialChainStepDto[] };
  policy_version_id: string;
  policy_checksum: string;
  requested_by: string;
  reason: string;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  withdrawn_at: string | null;
  expired_at: string | null;
  /** CCP-A9: set when a governed role change was applied (state APPLIED). */
  applied_at: string | null;
}

/** CCP-A9: the role-change apply that follows the completing approval (null otherwise). */
export interface CommercialRoleChangeApplyDto {
  applied: boolean;
  /** null when applied; else why it was refused (the request stays APPROVED). */
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface CommercialApprovalDto {
  id: string;
  step_index: number;
  approver_user_id: string;
  step_role_key: string;
  step_scope_keys: string[];
  approver_role_keys: string[];
  comment: string | null;
  created_at: string;
}

export interface CommercialChangeRequestDetailDto {
  request: CommercialChangeRequestDto;
  approvals: CommercialApprovalDto[];
  is_expired: boolean;
  chain_satisfiable: boolean | null;
  /** CCP-A6-R (TD-B2-3) — the caller may apply this request now (requester-only in v1). */
  apply_actionable: boolean;
  steps: Array<{
    step_index: number;
    role_key: string;
    scope_keys: string[];
    status: 'APPROVED' | 'NEXT' | 'WAITING';
    approval_id: string | null;
    caller: { eligible: boolean; refusal: string | null } | null;
  }>;
}
