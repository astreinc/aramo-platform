import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { PLATFORM_ROLE_KEYS, TENANT_ASSIGNABLE_ROLE_KEYS } from '@aramo/identity';

// POST /platform/tenants/:tenant_id/invitations — invite a user into an
// existing tenant with one or more AUTHZ-1 tenant roles. Lead ruling 8
// idempotency rules:
//   - existing User + existing membership in this tenant with the same
//     role set => 409 INVITATION_ALREADY_EXISTS (AdminGetUser sub check).
//   - existing User + existing membership in this tenant with a
//     different role set => 200 + the role-junction is reconciled.
//   - existing User + no membership in this tenant => 201 + new membership.
//   - no User (drift recovery — Cognito has user, identity does not)
//     => 201 + create identity rows from the existing Cognito sub.
//
// D-AUTHZ-PLATFORM-INVITE-1 (defense-in-depth): role_keys is constrained
// to the SEED_ROLE_KEYS closed set at the DTO boundary so a typo or
// injected value surfaces as 400 VALIDATION_ERROR BEFORE the DB roundtrip
// the IdentityService.resolveRoleIdsByKeys existence-check would have
// caught it on. The in-service D5 union-non-invertibility check (the
// primary fix) runs second; this guard is the cheaper first layer.
// IC-2 PR-5 — the allow-list is the TENANT-assignable partition: platform-tier
// keys (super_admin) are refused at the DTO (400) and again in-service, so a
// non-sentinel tenant membership can never carry platform-operator authority.
const ALLOWED_ROLE_KEYS: readonly string[] = [...TENANT_ASSIGNABLE_ROLE_KEYS];

export class InviteUserRequestDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsIn(ALLOWED_ROLE_KEYS, { each: true })
  role_keys!: string[];

  @IsOptional()
  @IsString()
  display_name?: string;
}

// POST /platform/admins/invitations — invite another platform admin against
// the PLATFORM Cognito pool (Lead ruling 4 A1). No tenant context — the
// invitee is bound to the sentinel platform_tenant + the super_admin role.
//
// CCP-A9 (PBD §5.1 row A9; Inc-1 Closure Amendment A1 A1-1, A1-5): the invite accepts
// PLATFORM_ROLE_KEYS for a NEW arrival (default ['super_admin'], the pre-A9 behaviour). A CCP
// role needs `human_ref_hash` (D9: SHA-256 hex of the attested human reference, no PII); the
// inviter, an attested platform_owner, is the attester. An existing platform member is
// refused: a role grant to an existing admin is a governed role-change request.
export class InvitePlatformAdminRequestDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  @IsIn([...PLATFORM_ROLE_KEYS], { each: true })
  role_keys?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  human_ref_hash?: string;
}

export interface InviteUserResponseDto {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  // IC-1 PR-1 (Amendment A1 §2): `membership_added` is RETIRED — an email owned
  // by another tenant is refused (409 EMAIL_UNAVAILABLE), never re-membered.
  status: 'invitation_sent' | 'roles_updated';
}
