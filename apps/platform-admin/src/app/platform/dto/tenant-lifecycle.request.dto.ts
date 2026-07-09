import { IsISO8601, IsOptional, IsString, MinLength } from 'class-validator';

// Platform-Console Increment-2 PR-1 — operator lifecycle action DTOs. Reason
// codes are mandatory for SUSPEND/CLOSE (text also for SUSPEND, per P3);
// OFFBOARDING requires closeAt + retentionPolicyCode (retentionPolicyCode is an
// opaque string — NO retention policy semantics ship, counsel-gated per P6). The
// service (TenantService.transitionTenantStatus) re-enforces every requirement,
// so these DTOs are the first (400-shape) gate, not the authority.

export class SuspendTenantRequestDto {
  @IsString()
  @MinLength(1)
  reasonCode!: string;

  @IsString()
  @MinLength(1)
  reasonText!: string;
}

export class ReactivateTenantRequestDto {
  @IsString()
  @MinLength(1)
  reasonCode!: string;
}

export class StartOffboardingRequestDto {
  // The retention policy code is stored opaquely (no semantics run; counsel-gated).
  @IsString()
  @MinLength(1)
  retentionPolicyCode!: string;

  // The effective close date (retention clock anchor). ISO-8601.
  @IsISO8601()
  closeAt!: string;

  @IsOptional()
  @IsString()
  reasonCode?: string;

  @IsOptional()
  @IsString()
  reasonText?: string;
}

export class CloseTenantRequestDto {
  @IsString()
  @MinLength(1)
  reasonCode!: string;

  @IsOptional()
  @IsString()
  reasonText?: string;
}

export interface TenantLifecycleActionResponseDto {
  tenant_id: string;
  from: string;
  to: string;
  status: string;
  changed: boolean;
}
