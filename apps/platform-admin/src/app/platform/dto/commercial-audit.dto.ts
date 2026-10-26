import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

// CCP-A2 — GET /platform/commercial/audit-events (platform:commercial:audit:read). The
// query DTO is the 400-shape gate; CommercialAuditRepository is the authority for paging.

export class CommercialAuditQueryDto {
  @IsOptional() @IsUUID() actor_id?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{2,99}$/) event_type?: string;
  @IsOptional() @IsUUID() tenant_id?: string;
  // Inclusive lower bound on created_at.
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  // Exclusive upper bound on created_at.
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsIn(['true', 'false']) exception_only?: 'true' | 'false';
  // CCP-B5 (handoff §5.7): the "Change request" and "Product" filters.
  @IsOptional() @IsUUID() change_request_id?: string;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{0,39}$/) product_key?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(2000) cursor?: string;
}

export interface CommercialAuditEventDto {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  actor_role_keys: string[];
  event_type: string;
  is_exception: boolean;
  tenant_id: string | null;
  subject: string;
  change_request_id: string | null;
  policy_version_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
}

export interface CommercialAuditListResponseDto {
  events: CommercialAuditEventDto[];
  next_cursor: string | null;
}
