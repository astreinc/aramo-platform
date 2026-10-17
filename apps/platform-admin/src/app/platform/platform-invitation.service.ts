import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import {
  DEFAULT_TENANT_CAPABILITIES,
  EntitlementRepository,
  type Capability,
  isCapability,
} from '@aramo/entitlement';
import {
  IdentityService,
  PLATFORM_ROLE_KEYS,
  TenantService,
  deriveAllowedDomainOrThrow,
  DEFAULT_TENANT_KIND,
  isTenantKind,
  PERSONAL_TENANT_CAPABILITIES,
  deriveSlugOrThrow,
  normalizeEmail,
} from '@aramo/identity';

import { CognitoAdminService } from './cognito/cognito-admin.service.js';
import { TenantPolicyProvisioningService } from './tenant-policy-provisioning.service.js';
import { TenantDocumentTemplateProvisioningService } from './tenant-document-template-provisioning.service.js';

// PlatformInvitationService — orchestrates the cross-schema saga (Lead
// ruling 7):
//   1. Cognito (TENANT or PLATFORM pool) — AdminCreateUser (Pattern A,
//      Lead ruling 1; Cognito owns credential + temp-password email).
//   2. Identity tx (libs/identity) — Tenant (provisioning case only) +
//      User + ExternalIdentity + Membership + MembershipRole, atomic.
//   3. Entitlement tx (libs/entitlement) — grant {core, ats, portal}
//      rows for the new tenant (provisioning case only).
//   4. Policy (ADR-0024 PR-4a-2) — copy the platform TEMPLATE
//      requisition-lifecycle package into the new tenant. Non-atomic with
//      step 2 by design (the seams share no transaction — libs/identity is
//      scope:shared and cannot reach policy-store); the startup coverage
//      guard + PR-4a add-time fail-closed are the reconciling safety nets.
//
// Compensation:
//   - Identity-tx failure (after Cognito returned a sub) -> AdminDeleteUser
//     (cognito rollback).
//   - Entitlement-tx failure (after identity-tx committed) -> SOFT-DISABLE
//     the new tenant (Lead ruling 7; the Cognito + identity rows stay
//     durable, the tenant becomes inert via TenantService.deactivateTenant
//     -> is_active=false; the EntitlementGuard blocks all capability
//     routes; the SessionOrchestrator refuses to issue tokens for an
//     inactive tenant).
//
// Idempotency / re-invite (Lead ruling 8, as amended by IC-1 PR-1 —
// D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 §2/§3/§4; one User, one tenant):
//   - existing User + existing membership in this tenant, same role set =>
//     409 INVITATION_ALREADY_EXISTS (no Cognito call at all).
//   - existing User + existing membership in this tenant, different role
//     set => reconcile UserTenantMembershipRole (roles_updated).
//   - existing User + NO membership in this tenant => the User is owned by
//     ANOTHER tenant: tenant-scoped audit identity.invitation.rejected_
//     cross_tenant + 409 EMAIL_UNAVAILABLE with `details: {}` — BEFORE any
//     Cognito call. The former `membership_added` outcome is RETIRED.
//   - drift (Cognito has user, identity does not) => recover by writing
//     identity rows against the existing Cognito sub (invitation_sent).
//   - greenfield (neither store) => Cognito-first AdminCreateUser, then the
//     identity mirror (invitation_sent).
// The identity probe is the FIRST probe and runs on the NORMALIZED email
// (trim + lowercase), so a Cognito-absent / identity-present state is
// resolved by the same-tenant / other-tenant branches without ever calling
// AdminCreateUser (and so without an AdminDeleteUser compensation).

export interface ProvisionResult {
  tenant_id: string;
  tenant_name: string;
  // IC-4 PR-9 — BUSINESS | PERSONAL.
  tenant_kind: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: Capability[];
  // Inc-3 PR-3.4 (B2) — whether the owner invitation email was sent at
  // provision (mirrors the request's invite_owner). Surfaced to the response.
  invitation_sent: boolean;
}

export interface InviteResult {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  // IC-1 PR-1: `membership_added` RETIRED (Amendment A1 §2).
  status: 'invitation_sent' | 'roles_updated';
}

@Injectable()
export class PlatformInvitationService {
  private readonly logger = new Logger(PlatformInvitationService.name);

  constructor(
    private readonly cognito: CognitoAdminService,
    private readonly tenantSvc: TenantService,
    private readonly identitySvc: IdentityService,
    private readonly entitlementRepo: EntitlementRepository,
    private readonly policyProvisioning: TenantPolicyProvisioningService,
    private readonly docTemplateProvisioning: TenantDocumentTemplateProvisioningService,
  ) {}

  async provisionTenantAndInviteOwner(args: {
    name: string;
    owner_email: string;
    owner_display_name?: string | null;
    capabilities?: readonly string[];
    actor_user_id: string;
    request_id: string;
    // Inc-3 PR-3.4 (R16, B1) — send the owner invitation now (true, default =
    // the pre-3.4 behavior) or defer it (false = create-now-invite-later: the
    // Cognito owner is created SUPPRESSed, no email; the send happens later via
    // the resend-owner-invite endpoint). Either way the tenant lands PROVISIONED.
    invite_owner: boolean;
    // IC-2 PR-4 (F-4) — optional subdomain slug, forwarded verbatim to
    // TenantService.provisionTenant (deriveSlugOrThrow validates it there).
    slug?: string;
    // IC-4 PR-9 — BUSINESS (default) | PERSONAL. A PERSONAL tenant: the
    // personal-provider pre-check is skipped (P1-A1; TenantService still
    // requires a well-formed address and stores allowed_domain NULL), the
    // capability set is CLOSED to PERSONAL_TENANT_CAPABILITIES ([core, esign];
    // any other requested capability → 400 BEFORE Cognito), the owner receives
    // org_admin (no ats → the N-2 product-neutral owner; never an ATS role) and
    // no ATS projection runs. Identity registration, tenant creation, product
    // entitlement and Sign sender eligibility stay separate steps.
    kind?: string;
  }): Promise<ProvisionResult> {
    const kind = args.kind ?? DEFAULT_TENANT_KIND;
    if (!isTenantKind(kind)) {
      throw new AramoError('VALIDATION_ERROR', 'Unknown tenant kind', 400, {
        requestId: args.request_id,
        details: { reason: 'invalid_tenant_kind', kind: args.kind },
      });
    }
    // 0. Validate capability set (default = core,ats,portal).
    // IC-3 PR-7 — product-neutral provisioning. `core` ("is an Aramo
    // organization") is ALWAYS held: the org routes are core-gated and the
    // owner must be able to administer the organization whatever products it
    // subscribes to. ATS is NOT a prerequisite: a Sign-only tenant is
    // [core, esign]; ATS+Sign is [core, ats, portal, esign]; the default bundle
    // (no capabilities supplied) is unchanged (HF2 DEFAULT_TENANT_CAPABILITIES).
    const requested: readonly Capability[] =
      args.capabilities === undefined || args.capabilities.length === 0
        ? DEFAULT_TENANT_CAPABILITIES
        : args.capabilities.filter(isCapability);
    const desiredRaw: readonly Capability[] = requested.includes('core')
      ? requested
      : ['core', ...requested];
    // IC-4 PR-9 (§4) — a PERSONAL tenant may hold ONLY the closed personal set.
    // Fail closed on anything else (an ATS/TIP entitlement for a personal
    // identity is a separately governed decision that does not exist). When no
    // capabilities are supplied the personal default is [core, esign], NOT the
    // business default bundle.
    const desired: readonly Capability[] =
      kind === 'PERSONAL'
        ? (() => {
            const personal =
              args.capabilities === undefined || args.capabilities.length === 0
                ? (PERSONAL_TENANT_CAPABILITIES as readonly Capability[])
                : desiredRaw;
            const disallowed = personal.filter((c) => !PERSONAL_TENANT_CAPABILITIES.includes(c));
            if (disallowed.length > 0) {
              throw new AramoError(
                'VALIDATION_ERROR',
                'A personal tenant may hold only the core and esign capabilities',
                400,
                {
                  requestId: args.request_id,
                  details: { reason: 'personal_tenant_capability_not_allowed', capabilities: disallowed },
                },
              );
            }
            return personal.includes('core') ? personal : ['core', ...personal];
          })()
        : desiredRaw;
    const atsEntitled = desired.includes('ats');
    // The owner role follows the product set: an ATS tenant keeps tenant_owner
    // (the ATS owner bundle, unchanged); a tenant WITHOUT ats receives
    // org_admin — the product-neutral organization administrator (no ATS, no
    // Sign, no platform authority). Sign SENDER roles are PR-8's call.
    const ownerRoleKey = atsEntitled ? 'tenant_owner' : 'org_admin';

    // 0a. Pre-check tenant name uniqueness (the service-layer raise still
    // re-checks — this avoids the Cognito side-effect for an obvious
    // conflict).
    const existing = await this.tenantSvc.findByNameCaseInsensitive(args.name);
    if (existing !== null) {
      throw new AramoError(
        'TENANT_ALREADY_EXISTS',
        'A tenant with this name already exists',
        409,
        {
          requestId: 'platform.provision',
          details: { name: args.name, existing_tenant_id: existing.id },
        },
      );
    }

    // 0a-bis. Domain-Enforcement P1 — reject a personal/disposable owner
    // domain BEFORE the Cognito side-effect. provisionTenant (step 2) is the
    // authoritative gate and would reject + the saga would AdminDeleteUser-
    // rollback, but Cognito AdminCreateUser emails a temp-password to the
    // owner address, so a personal recipient would receive an Aramo invite we
    // then revoke. This pre-check (the SAME single-source gate provisionTenant
    // runs) prevents that email entirely — mirrors the 0a name pre-check that
    // avoids a Cognito side-effect for an obvious conflict.
    // IC-4 PR-9 (P1-A1) — NOT applied to a PERSONAL tenant: a personal
    // subscriber signs up with a personal-provider address by definition.
    // TenantService.provisionTenant (step 2) remains the authoritative gate for
    // BOTH kinds (well-formed address; business → locked domain).
    if (kind !== 'PERSONAL') {
      deriveAllowedDomainOrThrow(args.owner_email, 'platform.provision');
    }

    // 0a-bis-2. IC-2 PR-4 (F-4) — validate a supplied slug BEFORE the Cognito
    // side-effect with the SAME single-source gate provisionTenant runs
    // (deriveSlugOrThrow: DNS-safe label, reserved-slug refusal). A reserved or
    // malformed slug is an obvious 400 that must not cost an AdminCreateUser +
    // compensation round-trip (and a temp-password email). Uniqueness stays
    // with the database (Tenant.slug UNIQUE) inside provisionTenant. Never
    // derived from the name.
    if (args.slug !== undefined) {
      deriveSlugOrThrow(args.slug, args.request_id);
    }

    // 0a-ter. IC-1 PR-1 (Amendment A1 §4) — one User, one tenant. The tenant
    // being provisioned does not exist yet, so ANY existing identity.User for
    // the (normalized) owner email is owned by another tenant. Refuse BEFORE
    // the Cognito side effect (AdminCreateUser would email a temp password to
    // an address we then revoke). The in-service guard inside
    // createUserFromInvitation is the authoritative backstop (it also covers
    // the pre-check/insert race); this pre-check only avoids the Cognito
    // round-trip + compensation. No target tenant exists yet, so the
    // tenant-scoped rejected_cross_tenant audit event cannot be written here;
    // the refusal is logged at warn with the request id instead.
    const ownerEmail = normalizeEmail(args.owner_email);
    const ownerExisting = await this.identitySvc.findUserByEmail(ownerEmail);
    if (ownerExisting !== null) {
      this.logger.warn(
        `provision refused (request ${args.request_id}): owner email already registered to an existing user`,
      );
      throw new AramoError(
        'EMAIL_UNAVAILABLE',
        'This email address is not available for invitation',
        409,
        { requestId: args.request_id, details: {} },
      );
    }

    // 0b. Resolve role IDs (the Tenant-Owner-first invite hard-fixes
    // the role to 'tenant_owner').
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys([ownerRoleKey]);

    // 1. Cognito (TENANT pool) — AdminCreateUser. Pattern A: Cognito
    // owns the credential + invitation email; Aramo never holds a
    // password.
    let cognito_sub: string;
    try {
      const out = await this.cognito.adminCreateUser({
        pool: 'tenant',
        email: args.owner_email,
        display_name: args.owner_display_name ?? null,
        // invite_owner=false → SUPPRESS the invitation email at creation
        // (create-now-invite-later). The user is still created in
        // FORCE_CHANGE_PASSWORD; the resend endpoint (RESEND) sends later.
        suppress: !args.invite_owner,
      });
      cognito_sub = out.cognito_sub;
    } catch (err) {
      this.logger.warn(
        `cognito admin create user failed: ${(err as Error).message}`,
      );
      throw new AramoError(
        'COGNITO_PROVISION_FAILED',
        'Cognito AdminCreateUser failed',
        502,
        {
          requestId: 'platform.provision',
          details: {
            email: args.owner_email,
            pool: 'tenant',
            error_message: (err as Error).message,
          },
        },
      );
    }

    // 2. Identity tx — Tenant + User + ExternalIdentity + Membership +
    // MembershipRole. On failure -> compensate Cognito (AdminDeleteUser).
    let tenant_id: string;
    let owner_user_id: string;
    let membership_id: string;
    try {
      const tenant = await this.tenantSvc.provisionTenant({
        name: args.name,
        owner_email: args.owner_email,
        actor_user_id: args.actor_user_id,
        // B2 — record on the provision event whether the invite went out.
        invitation_sent: args.invite_owner,
        // IC-2 PR-4 (F-4) — only forwarded when supplied (slug NULL otherwise).
        ...(args.slug === undefined ? {} : { slug: args.slug }),
        // IC-4 PR-9 — the kind reaches the identity spine (allowed_domain NULL
        // for PERSONAL is decided THERE, the single-source placement).
        kind,
      });
      tenant_id = tenant.id;
      // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded so the
      // in-service D5 union-non-invertibility check has what it needs. The
      // owner role is hard-fixed to ['tenant_owner'] (a see-all-tier role
      // exempted by the validator's bypass) so the bundle math is trivially
      // safe — but the threading is uniform across all callers.
      const created = await this.identitySvc.createUserFromInvitation({
        email: args.owner_email,
        display_name: args.owner_display_name ?? null,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id,
        role_keys: [ownerRoleKey],
        role_ids,
        actor_user_id: args.actor_user_id,
        request_id: args.request_id,
        // D-ORG (§3.F) — the owner role is product-partitioned (tenant_owner = ATS,
        // org_admin = neutral); the entitlement rows are written in step 3, so the
        // gate evaluates against the set this saga is about to grant.
        provisioning_capabilities: desired,
      });
      owner_user_id = created.user.id;
      membership_id = created.membership_id;
    } catch (err) {
      await this.compensateCognito({
        email: args.owner_email,
        pool: 'tenant',
        expected_sub: cognito_sub,
      }).catch(
        (compErr: unknown) => {
          this.logger.warn(
            `cognito rollback failed: ${(compErr as Error).message}`,
          );
        },
      );
      throw err;
    }

    // 3. Entitlement tx — soft-disable the tenant on failure (Lead
    // ruling 7).
    try {
      await this.entitlementRepo.grantCapabilities({
        tenant_id,
        capabilities: desired,
      });
    } catch (err) {
      this.logger.warn(
        `entitlement grant failed; soft-disabling tenant ${tenant_id}: ${
          (err as Error).message
        }`,
      );
      await this.tenantSvc.deactivateTenant({
        tenant_id,
        actor_user_id: args.actor_user_id,
        reason: 'entitlement_grant_failed',
      });
      throw new AramoError(
        'INTERNAL_ERROR',
        'Entitlement seed failed; tenant soft-disabled',
        500,
        {
          requestId: 'platform.provision',
          details: { tenant_id, reason: 'entitlement_grant_failed' },
        },
      );
    }

    // 4. Policy (ADR-0024 PR-4a-2) — publish the tenant's requisition-lifecycle
    // package as a byte-identical copy of the platform template. Without it the
    // tenant's add-talent path fails closed (PR-4a: no package = DENY), so the
    // tenant would be live but non-functional. On failure -> SOFT-DISABLE (the
    // same compensation class as the entitlement step, Lead ruling 7): a tenant
    // that cannot add talent must be inert, not silently broken. The startup
    // coverage guard (apps/api) and the add-time fail-closed are the reconciling
    // safety nets for the non-atomic gap.
    // IC-3 PR-7 — the two ATS projections (the default lifecycle policy package
    // and the default RTR document template) run ONLY for an ATS-entitled
    // tenant. A Sign-only organization gets no ATS projection, no ATS
    // dependency and no ATS assignment; compensation semantics are unchanged.
    if (atsEntitled) {
      try {
        await this.policyProvisioning.publishDefaultLifecyclePackage(tenant_id);
      } catch (err) {
        this.logger.warn(
          `policy package publish failed; soft-disabling tenant ${tenant_id}: ${
            (err as Error).message
          }`,
        );
        await this.tenantSvc.deactivateTenant({
          tenant_id,
          actor_user_id: args.actor_user_id,
          reason: 'policy_package_publish_failed',
        });
        throw new AramoError(
          'INTERNAL_ERROR',
          'Policy package publish failed; tenant soft-disabled',
          500,
          {
            requestId: 'platform.provision',
            details: { tenant_id, reason: 'policy_package_publish_failed' },
          },
        );
      }

      // 5. Documents (RTR-TEMPLATE-1 §7) — publish the tenant's default RTR
      // template as a byte-identical copy of the platform template. Same
      // fail-closed compensation class as policy (Lead ruling 7): a tenant that
      // cannot resolve an RTR template cannot produce an RTR, which gates
      // submittal, so it must be inert rather than silently broken. The
      // existing-tenant backfill migration + this seam together guarantee every
      // tenant resolves exactly one ACTIVE tenant-wide RTR template (INV-12, no
      // inline fallback). On failure -> SOFT-DISABLE.
      try {
        await this.docTemplateProvisioning.publishDefaultRtrTemplate(tenant_id);
      } catch (err) {
        this.logger.warn(
          `RTR template publish failed; soft-disabling tenant ${tenant_id}: ${
            (err as Error).message
          }`,
        );
        await this.tenantSvc.deactivateTenant({
          tenant_id,
          actor_user_id: args.actor_user_id,
          reason: 'rtr_template_publish_failed',
        });
        throw new AramoError(
          'INTERNAL_ERROR',
          'RTR template publish failed; tenant soft-disabled',
          500,
          {
            requestId: 'platform.provision',
            details: { tenant_id, reason: 'rtr_template_publish_failed' },
          },
        );
      }

      // B2 — emit tenant.owner_invite.sent ONLY when mail actually went (the
      // invite_owner=true path; the Cognito email was sent above without SUPPRESS).
      // reason=first_send: this is the owner's first invitation. On the deferred
      // path (invite_owner=false) nothing is emitted — the send happens later via
      // the resend-owner-invite endpoint, which emits its own first_send there.
    }

    if (args.invite_owner) {
      await this.tenantSvc.recordOwnerInviteSent({
        tenant_id,
        owner_user_id,
        actor_id: args.actor_user_id,
        reason: 'first_send',
      });
    }

    return {
      tenant_id,
      tenant_name: args.name,
      tenant_kind: kind,
      owner_user_id,
      owner_email: args.owner_email,
      membership_id,
      capabilities: [...desired],
      invitation_sent: args.invite_owner,
    };
  }

  async inviteUserIntoTenant(args: {
    tenant_id: string;
    email: string;
    role_keys: readonly string[];
    display_name?: string | null;
    actor_user_id: string;
    pool: 'tenant' | 'platform';
    request_id: string;
  }): Promise<InviteResult> {
    // IC-2 PR-5 — platform-tier role keys (super_admin) are assignable ONLY
    // against the platform pool/sentinel. Refuse BEFORE any Cognito side effect
    // (the greenfield branch is Cognito-first) and before the DB; the in-service
    // guard inside the identity writes is the authoritative backstop.
    if (args.pool !== 'platform') {
      const platformKeys = args.role_keys.filter((k) =>
        (PLATFORM_ROLE_KEYS as readonly string[]).includes(k),
      );
      if (platformKeys.length > 0) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'Platform-tier roles cannot be assigned to a tenant membership',
          400,
          {
            requestId: args.request_id,
            details: { reason: 'platform_role_not_assignable', role_keys: platformKeys },
          },
        );
      }
    }
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys(args.role_keys);

    // IC-1 PR-1 (Amendment A1 §4) — normalize ONCE (trim + lowercase) and use
    // the normalized form for the identity probe, the Cognito probe, the
    // Cognito create and the identity mirror (the raw email was previously
    // used for the probes while the tenant tier normalized — the
    // inconsistency this closes). Cognito's Username=email convention is
    // honored with the normalized form on every call below.
    const email = normalizeEmail(args.email);

    // Identity is the FIRST probe (one User, one tenant). An existing User is
    // resolved by its membership in THIS tenant (same-tenant contracts) or
    // refused (owned by another tenant) BEFORE any Cognito call — so the
    // Cognito-absent / identity-present state never reaches AdminCreateUser.
    const ownership = await this.identitySvc.classifyInviteEmailOwnership({
      email,
      tenant_id: args.tenant_id,
    });

    if (ownership.kind === 'other_tenant') {
      // Cross-tenant collision (Amendment A1 §4): tenant-scoped audit with
      // the actual reason + 409 EMAIL_UNAVAILABLE, `details: {}`. The former
      // "new tenant for existing user" (membership_added) branch is RETIRED.
      await this.identitySvc.rejectCrossTenantInvitation({
        tenant_id: args.tenant_id,
        actor_user_id: args.actor_user_id,
        request_id: args.request_id,
        tier: 'platform',
        existing: ownership,
        reason:
          ownership.membership_tenant_ids.length === 0
            ? 'existing_user_without_membership'
            : 'existing_user_owned_by_other_tenant',
      });
    }

    if (ownership.kind === 'same_tenant') {
      // Cases 1 (409) + 2 (reconcile) — the user already holds a membership
      // in THIS tenant. Branch on the role set. No Cognito call on either
      // branch (preserved same-tenant contracts, Amendment A1 §3).
      const membership = ownership.membership;
      const existingRoleIds = new Set(
        await this.identitySvc.findRoleIdsForMembership(membership.id),
      );
      const wantSet = new Set(role_ids);
      const sameSet =
        existingRoleIds.size === wantSet.size &&
        [...existingRoleIds].every((id) => wantSet.has(id));
      if (sameSet) {
        throw new AramoError(
          'INVITATION_ALREADY_EXISTS',
          'User already holds a membership in this tenant with the same role set',
          409,
          {
            requestId: 'platform.invite',
            details: {
              email,
              tenant_id: args.tenant_id,
              existing_membership_id: membership.id,
            },
          },
        );
      }
      // Same-tenant role replacement (Lead ruling 8 case 2).
      // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded for
      // the in-service D5 union-non-invertibility check.
      await this.identitySvc.replaceMembershipRoles({
        membership_id: membership.id,
        tenant_id: args.tenant_id,
        role_keys: args.role_keys,
        role_ids,
        request_id: args.request_id,
        // IC-2 PR-5 — platform-tier keys only for the platform pool/sentinel.
        allow_platform_roles: args.pool === 'platform',
      });
      return {
        tenant_id: args.tenant_id,
        user_id: ownership.user.id,
        membership_id: membership.id,
        role_keys: [...args.role_keys],
        status: 'roles_updated',
      };
    }

    // Identity has no User for this email. AdminGetUser is the existence
    // probe at the Cognito boundary (Lead ruling 8) — normalized email.
    const cognitoExisting = await this.cognito.adminGetUser({
      pool: args.pool,
      email,
    });

    if (cognitoExisting !== null) {
      // Drift recovery (Lead ruling 8 case 4). Reuse the existing
      // Cognito sub; write identity rows mirror-style. The in-service
      // guard re-checks ownership (and maps a lost email race) before
      // the write.
      // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded for
      // the in-service D5 union-non-invertibility check.
      const created = await this.identitySvc.createUserFromInvitation({
        email,
        display_name: args.display_name ?? null,
        provider: 'cognito',
        provider_subject: cognitoExisting.cognito_sub,
        tenant_id: args.tenant_id,
        role_keys: args.role_keys,
        role_ids,
        actor_user_id: args.actor_user_id,
        request_id: args.request_id,
        allow_platform_roles: args.pool === 'platform',
      });
      return {
        tenant_id: args.tenant_id,
        user_id: created.user.id,
        membership_id: created.membership_id,
        role_keys: [...args.role_keys],
        status: 'invitation_sent',
      };
    }

    // Greenfield: neither store has the user. Pattern A — Cognito-first.
    let cognito_sub: string;
    try {
      const out = await this.cognito.adminCreateUser({
        pool: args.pool,
        email,
        display_name: args.display_name ?? null,
      });
      cognito_sub = out.cognito_sub;
    } catch (err) {
      throw new AramoError(
        'COGNITO_PROVISION_FAILED',
        'Cognito AdminCreateUser failed',
        502,
        {
          requestId: 'platform.invite',
          details: {
            email,
            pool: args.pool,
            error_message: (err as Error).message,
          },
        },
      );
    }

    let created;
    try {
      // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded for
      // the in-service D5 union-non-invertibility check. An invertible
      // bundle throws VALIDATION_ERROR inside createUserFromInvitation —
      // the catch block below rolls back the Cognito user so neither
      // store retains the invertible state. IC-1 PR-1: a User.email race
      // lost between the probe above and the insert surfaces from inside
      // createUserFromInvitation as the governed 409 (EMAIL_UNAVAILABLE /
      // INVITATION_ALREADY_EXISTS) — the same rollback applies.
      created = await this.identitySvc.createUserFromInvitation({
        email,
        display_name: args.display_name ?? null,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id: args.tenant_id,
        role_keys: args.role_keys,
        role_ids,
        actor_user_id: args.actor_user_id,
        request_id: args.request_id,
        allow_platform_roles: args.pool === 'platform',
      });
    } catch (err) {
      await this.compensateCognito({
        email,
        pool: args.pool,
        expected_sub: cognito_sub,
      }).catch(
        (compErr: unknown) => {
          this.logger.warn(
            `cognito rollback failed: ${(compErr as Error).message}`,
          );
        },
      );
      throw err;
    }
    return {
      tenant_id: args.tenant_id,
      user_id: created.user.id,
      membership_id: created.membership_id,
      role_keys: [...args.role_keys],
      status: 'invitation_sent',
    };
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — re-send the tenant owner's
  // invitation. The owner was invited during provisioning via Pattern A
  // (Cognito AdminCreateUser emails the temp password); this re-delivers that
  // email without recreating anything.
  //
  // REUSE-vs-REISSUE (the invite machinery's call, reported): re-issue REUSES
  // the existing Cognito user (same `sub`) and every identity row (User /
  // Membership / MembershipRole / ExternalIdentity) — nothing is recreated. The
  // owner invite is NOT a token-`Invitation` row (that model backs the Pattern-2
  // federated-invite flow, not the Cognito owner flow), so there is NO INVITED
  // row to reissue here; reuse is at the Cognito-user level, and the sole effect
  // is a fresh temp-password email via Cognito MessageAction=RESEND.
  //
  // GATE ↔ RESEND-ELIGIBILITY: the tenant must be PROVISIONED. This is both the
  // product rule (resending an owner invite to an already-activated tenant is a
  // mistake, not a feature) AND the Cognito precondition — a PROVISIONED tenant's
  // owner has not yet accepted (acceptance activates the tenant → ACTIVE, R9/R10),
  // so the Cognito user is still FORCE_CHANGE_PASSWORD and RESEND is valid. Once
  // ACTIVE, Cognito would reject RESEND anyway; the gate and Cognito agree.
  async resendOwnerInvite(args: {
    tenant_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<{
    tenant_id: string;
    owner_user_id: string;
    owner_email: string;
    resent: true;
  }> {
    const tenant = await this.tenantSvc.getTenantById(args.tenant_id);
    if (tenant === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId: args.request_id,
        details: { tenant_id: args.tenant_id },
      });
    }
    if (tenant.status !== 'PROVISIONED') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Owner invite can only be resent while the tenant is PROVISIONED',
        422,
        {
          requestId: args.request_id,
          details: {
            reason: 'tenant_not_provisioned',
            tenant_id: args.tenant_id,
            status: tenant.status,
          },
        },
      );
    }
    const owner = await this.identitySvc.findTenantOwner(args.tenant_id);
    if (owner === null) {
      // A PROVISIONED tenant always has a tenant_owner membership (provisioning
      // creates it). Absence is a data-integrity fault, not a client error.
      throw new AramoError(
        'INTERNAL_ERROR',
        'PROVISIONED tenant has no tenant_owner membership',
        500,
        {
          requestId: args.request_id,
          details: { tenant_id: args.tenant_id },
        },
      );
    }
    // Inc-3 PR-3.4 (B3) — first_send vs resend, derived from invite history:
    // a tenant provisioned with invite_owner=false has no prior
    // tenant.owner_invite.sent, so THIS is the first send (first_send); a tenant
    // already invited (at provision or a prior resend) → resend. The Cognito
    // call is identical (RESEND re-delivers + resets the temp password whether
    // or not a message was sent at creation).
    const priorSent = await this.tenantSvc.hasOwnerInviteBeenSent(args.tenant_id);
    await this.cognito.adminResendInvite({ pool: 'tenant', email: owner.email });
    await this.tenantSvc.recordOwnerInviteSent({
      tenant_id: args.tenant_id,
      owner_user_id: owner.user_id,
      actor_id: args.actor_user_id,
      reason: priorSent ? 'resend' : 'first_send',
    });
    return {
      tenant_id: args.tenant_id,
      owner_user_id: owner.user_id,
      owner_email: owner.email,
      resent: true,
    };
  }

  async invitePlatformAdmin(args: {
    email: string;
    display_name?: string | null;
    actor_user_id: string;
    request_id: string;
  }): Promise<InviteResult> {
    return this.inviteUserIntoTenant({
      tenant_id: PLATFORM_TENANT_SENTINEL_ID,
      email: args.email,
      role_keys: ['super_admin'],
      display_name: args.display_name ?? null,
      actor_user_id: args.actor_user_id,
      pool: 'platform',
      request_id: args.request_id,
    });
  }

  // Lead ruling 7 compensation, hardened at IC-1 PR-1 Gate-5 (FIX_NOW-2):
  // compensation may delete ONLY the Cognito identity THIS operation created.
  // Cognito's Username=email convention means AdminDeleteUser is addressed by
  // email, so before deleting we re-read the identity and require its `sub`
  // to equal the `sub` AdminCreateUser returned to us. A missing identity is
  // a no-op; a DIFFERENT sub (an established identity that was not ours) is
  // left untouched and logged. AdminCreateUser itself refuses an existing
  // username (UsernameExistsException → 502 COGNITO_PROVISION_FAILED before
  // any compensation), so a pre-existing Cognito identity never reaches this
  // path with a matching sub.
  private async compensateCognito(args: {
    email: string;
    pool: 'tenant' | 'platform';
    expected_sub: string;
  }): Promise<void> {
    const current = await this.cognito.adminGetUser({
      pool: args.pool,
      email: args.email,
    });
    if (current === null || current === undefined) {
      this.logger.warn(
        'cognito rollback skipped: no identity found for the created username',
      );
      return;
    }
    if (current.cognito_sub !== args.expected_sub) {
      this.logger.warn(
        'cognito rollback skipped: the identity at this username is not the one this operation created',
      );
      return;
    }
    await this.cognito.adminDeleteUser({ pool: args.pool, email: args.email });
  }
}
