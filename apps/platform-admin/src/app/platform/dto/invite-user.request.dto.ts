import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { SEED_ROLE_KEYS } from '@aramo/identity';

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
const ALLOWED_ROLE_KEYS: readonly string[] = [...SEED_ROLE_KEYS];

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
export class InvitePlatformAdminRequestDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  display_name?: string;
}

export interface InviteUserResponseDto {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  status: 'invitation_sent' | 'roles_updated' | 'membership_added';
}
