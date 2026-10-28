import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

// Aramo-Sign-Mobile-Amendment-M-A7 §3 — operator privacy-request action DTOs (the
// 400-shape gate; PrivacyRequestService is the authority for every transition).

export class RecordPrivacyRequestDto {
  @IsIn(['DELETION', 'ACCESS', 'EXPORT', 'CORRECTION'])
  request_type!: 'DELETION' | 'ACCESS' | 'EXPORT' | 'CORRECTION';

  @IsIn(['ACCOUNT_HOLDER', 'BUSINESS_MEMBER', 'GUEST_SIGNER', 'FORMER_USER', 'AUTHORIZED_REPRESENTATIVE'])
  subject_kind!: 'ACCOUNT_HOLDER' | 'BUSINESS_MEMBER' | 'GUEST_SIGNER' | 'FORMER_USER' | 'AUTHORIZED_REPRESENTATIVE';

  // The data subject's email (the account email when there is one).
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // How the operator checked identity / the agent's authority (e.g. "signed authorization
  // letter checked, case 1234"). Recorded in the append-only history.
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  verification_note!: string;
}

export class PrivacyNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}

export class AssignPrivacyRequestDto {
  // Omitted = the calling operator.
  @IsOptional()
  @IsUUID()
  operator_id?: string;
}

export class ReferPrivacyRequestDto {
  // Omitted = the subject's own organization.
  @IsOptional()
  @IsUUID()
  organization_tenant_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}
