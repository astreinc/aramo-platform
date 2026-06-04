import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
} from 'class-validator';

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
export class InviteUserRequestDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
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
