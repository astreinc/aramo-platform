import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { TENANT_KINDS } from '@aramo/identity';

// POST /platform/tenants — provision a tenant + invite the Tenant Owner
// as the singular first act (Lead ruling 6). The platform-admin caller
// supplies the tenant name + the owner's email; the platform-admin
// service composes TenantService.provisionTenant +
// IdentityService.createUserFromInvitation with role_keys=['tenant_owner'].
//
// Optional owner_display_name carries through to the Cognito 'name'
// attribute (AdminCreateUser UserAttributes) and the identity.User
// display_name column.
export class ProvisionTenantRequestDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  owner_email!: string;

  @IsOptional()
  @IsString()
  owner_display_name?: string;

  // Capability set defaults to {core, ats, portal} per the PR-A1b default
  // posture; an empty / partial set is accepted for tests/staging. Sourcing
  // remains deferred (Ruling 3 from PR-A1b).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  // Inc-3 PR-3.4 (R16, create-now-invite-later) — send the owner's invitation
  // email now (default) or defer it. When omitted or true, the owner is invited
  // during provisioning exactly as before (byte-preserved). When false, the
  // owner's Cognito user is created SUPPRESSed (no email); the operator sends
  // the invite when the owner is ready to onboard via POST .../resend-owner-invite.
  // The tenant lands PROVISIONED either way.
  @IsOptional()
  @IsBoolean()
  invite_owner?: boolean;

  // IC-2 PR-4 (F-4) — OPTIONAL subdomain slug for the new tenant. Validated by
  // the single-source gate deriveSlugOrThrow (DNS-safe label, reserved-slug
  // refusal) and UNIQUE at the database; NEVER derived from the name. Omitted →
  // the tenant is created without a subdomain (slug NULL, the pre-PR-4 shape).
  // Production host-binding enforcement (AUTH_HOST_TENANT_BINDING=enforce)
  // requires every tenant that logs in on a tenant host to carry a slug.
  @IsOptional()
  @IsString()
  slug?: string;

  // IC-4 PR-9 — BUSINESS (default; byte-preserved pre-PR-9 path) or PERSONAL
  // (one-person Sign subscriber: personal-provider owner email allowed,
  // allowed_domain NULL, capabilities CLOSED to [core, esign], owner role
  // org_admin, no ATS projection). Validated at the DTO (400 on any other
  // value) and again in-service (single-source TENANT_KINDS).
  @IsOptional()
  @IsIn([...TENANT_KINDS])
  kind?: string;
}
