import { IsString, MaxLength, MinLength } from 'class-validator';

// Domain-Enforcement P3 (LOCKED) §6 — operator domain-claim action DTOs (the
// first, 400-shape gate; DomainClaimService is the authority). Every action is
// audited in the same transaction as the write.

export class ReleaseTenantDomainRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class PromoteTenantDomainRequestDto {
  // A reference to the recorded domain-control evidence (ticket, document id…).
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  evidence_ref!: string;
}

export class GrantTenantDomainExceptionRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  justification!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  evidence_ref!: string;
}

export interface TenantDomainClaimDto {
  domain: string;
  claim: 'PROVISIONAL' | 'AUTHORITATIVE' | 'LAPSED' | 'RELEASED';
  expires_at: string | null;
  reason: string | null;
  exception: boolean;
}

export interface TenantDomainExceptionDto {
  id: string;
  domain: string;
  justification: string;
  evidence_ref: string;
  granted_by_user_id: string;
  granted_at: string;
  revoked_by_user_id: string | null;
  revoked_at: string | null;
}

export interface TenantDomainResponseDto {
  tenant_id: string;
  domain_claim: TenantDomainClaimDto | null;
  exceptions: TenantDomainExceptionDto[];
}
