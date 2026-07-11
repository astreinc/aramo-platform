import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { ExternalIdentityDto } from './dto/external-identity.dto.js';
import type { InvitationDto } from './dto/invitation.dto.js';
import type { MembershipDto } from './dto/membership.dto.js';
import type { UserDto } from './dto/user.dto.js';
import {
  IdentityRepository,
  type AssignableUserView,
  type DirectoryUserView,
  type TenantUserView,
} from './identity.repository.js';
import {
  displayFromDescription,
  metaRank,
} from './role-catalog/role-catalog.view.js';
import { RoleBundleValidator } from './tenant-user/role-bundle-validator.js';
import {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
} from './tenant-user/invitation-token.js';

// Aramo-Identity-Me-Endpoint — the public shape returned by GET /v1/me. A
// self-read display projection (NOT the admin TenantUserView): the caller's
// own name + email, the human display names of ALL their roles in this tenant
// (multi-role shows every role), and the tenant org label (display_name with
// a fall back to the workspace name so it is never empty). Carries no scopes,
// no status, no IDs — the JWT remains the lean authorization token; this is the
// display companion (the session DTO stays frozen at 6 fields).
export interface MeView {
  user: { display_name: string | null; email: string };
  roles: string[];
  // Inc-3 PR-3.5 (Workstream C) — `status` is the tenant lifecycle state
  // (ACTIVE / OFFBOARDING / …), added so the shell can render the OFFBOARDING
  // winding-down banner. It is a DISPLAY signal on the display companion; the
  // session JWT stays frozen at 6 fields (the mint gate remains the authority).
  tenant: { display_name: string; status: string };
}

// IdentityService — at AUTHZ-1, this surface was resolve-only (the original
// "never creates a User" §3 + §11 halt rule), with the auth-service
// SessionOrchestrator the only consumer.
//
// AUTHZ-2 (Lead ruling 9): the create surface is added, BOUNDED to the
// invitation flow Pattern A (Cognito-first AdminCreateUser -> mirror to
// identity). createUserFromInvitation is the platform-tier write seam;
// the resolve path (resolveUser) is untouched and remains the auth-
// service /callback seam. The Nx boundary asserts the create method is
// reachable only from apps/platform-admin (no tenant feature lib /
// apps/api edge); the §5 step 8 regression proof guards no behavior
// change for the resolve path consumers.
//
// D-AUTHZ-PLATFORM-INVITE-1 (Gate-6, in-service ruling): the D5 union-non-
// invertibility check moves INTO the three membership-role-write methods
// (createUserFromInvitation / addMembershipForExistingUser /
// replaceMembershipRoles). The prior caller-side contract (documented but
// unenforced) was honored by the tenant tier and silently violated by the
// platform tier — a super_admin could persist an invertible scope union
// via POST /platform/tenants/:tenant_id/invitations. Safe-by-construction:
// every caller (tenant, platform, future) is now covered without remembering
// to call the validator. The validator throw fires BEFORE any DB write or
// audit emission, so audit-on-success is preserved. The validator no-ops
// at length<2 (single-role invites are zero-cost). The identity → field-
// masking edge already exists (S3a) and is acyclic.
@Injectable()
export class IdentityService {
  constructor(
    private readonly identityRepo: IdentityRepository,
    private readonly audit: IdentityAuditService,
    private readonly roleBundle: RoleBundleValidator,
  ) {}

  async resolveUser(args: {
    provider: string;
    provider_subject: string;
  }): Promise<UserDto | null> {
    return this.identityRepo.findUserByExternalIdentity(args);
  }

  async findUserByEmail(email: string): Promise<UserDto | null> {
    return this.identityRepo.findUserByEmail(email);
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — resolve a tenant's owner
  // (user_id + email) for the resend-owner-invite Cognito re-send.
  async findTenantOwner(
    tenant_id: string,
  ): Promise<{ user_id: string; email: string } | null> {
    return this.identityRepo.findTenantOwner(tenant_id);
  }

  // §5 Auth-Hardening D2 — the reconcile-by-verified-email spine's link step.
  // Links a federated sub to an EXISTING User (resolved by verified email).
  // Delegates to the repository's NO-OP linkExternalIdentity: an idempotent
  // upsert on the (provider, provider_subject) unique key whose `update: {}`
  // REFUSES to re-point an already-linked sub (link-if-absent only). Creates
  // no User and no membership — the User must already exist (the caller
  // matched it by verified email; open JIT / tenant auto-create is NOT here).
  // The reconcile fires only on a resolveUser-by-sub MISS, so the (provider,
  // sub) row is absent and only the upsert's create branch is reached — the
  // no-op is therefore byte-equivalent on this path AND forecloses account-
  // takeover by re-point (§5 D2 §B; the recon's load-bearing instruction).
  async linkExternalIdentity(args: {
    user_id: string;
    provider: string;
    provider_subject: string;
    email_snapshot: string | null;
  }): Promise<ExternalIdentityDto> {
    return this.identityRepo.linkExternalIdentity(args);
  }

  async findUserById(user_id: string): Promise<UserDto | null> {
    return this.identityRepo.findUserById(user_id);
  }

  async findMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<MembershipDto | null> {
    return this.identityRepo.findMembership(args);
  }

  // Aramo-Identity-Me-Endpoint — the self-read behind GET /v1/me. Resolves the
  // caller's own display data (NEVER another user's — the repo keys on the
  // composite (user_id, tenant_id) from the JWT). Returns null when the caller
  // has no membership in the tenant (the controller maps null → 404).
  //
  // Roles: ALL of the caller's active roles, projected to their human display
  // names (displayFromDescription — the same source the roles-catalog uses) and
  // ordered by presentation tier then name (metaRank), so a multi-role user
  // reads e.g. "Tenant Admin" before "Recruiter". The role line shows every
  // role; an empty membership (no roles) yields [].
  //
  // Tenant label: display_name, falling back to the workspace `name` when the
  // branding label is unset — never empty.
  async getMe(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<MeView | null> {
    const ctx = await this.identityRepo.findMeContext(args);
    if (ctx === null) return null;
    const roles = [...ctx.roles]
      .sort(
        (a, b) =>
          metaRank(a.key) - metaRank(b.key) ||
          displayFromDescription(a.description, a.key).localeCompare(
            displayFromDescription(b.description, b.key),
          ),
      )
      .map((r) => displayFromDescription(r.description, r.key));
    return {
      user: { display_name: ctx.display_name, email: ctx.email },
      roles,
      tenant: {
        display_name: ctx.tenant_display_name ?? ctx.tenant_name,
        status: ctx.tenant_status,
      },
    };
  }

  // Settings S5-BE1 — tenant-users reads (the S5b prereq). The user-roster
  // is an ADMIN function gated by tenant:admin:user-manage; the read is
  // TENANT-WIDE within the admin scope (NOT D4b work-visibility-scoped —
  // the mutate side of the controller is already tenant-wide; a narrowed
  // read would be incoherent). The repo scopes the WHERE to tenant_id;
  // the controller derives tenant_id from authContext.
  async listTenantUsers(tenant_id: string): Promise<TenantUserView[]> {
    return this.identityRepo.listTenantUsers(tenant_id);
  }

  // §5 Auth-Hardening D4 — the recruiter-scoped minimal assignable roster
  // (broad: all active tenant members — the non-requisition pickers).
  async listAssignableTenantUsers(
    tenant_id: string,
  ): Promise<AssignableUserView[]> {
    return this.identityRepo.listAssignableTenantUsers(tenant_id);
  }

  // §5 Auth-Hardening D4 — the client-filtered assignable roster (the
  // requisition picker): active + client-mapped (user_ids resolved upstream
  // from company.UserClientAssignment) + req-carrying role.
  async listAssignableTenantUsersByIdsAndRoles(args: {
    tenant_id: string;
    user_ids: readonly string[];
    role_keys: readonly string[];
  }): Promise<AssignableUserView[]> {
    return this.identityRepo.listAssignableTenantUsersByIdsAndRoles(args);
  }

  // §5 Auth-Hardening D4b — the name-resolver directory (id→name for ALL tenant
  // users incl. inactive; optional batch user_ids).
  async listTenantUserDirectory(args: {
    tenant_id: string;
    user_ids?: readonly string[];
  }): Promise<DirectoryUserView[]> {
    return this.identityRepo.listTenantUserDirectory(args);
  }

  async getTenantUser(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<TenantUserView | null> {
    return this.identityRepo.getTenantUser(args);
  }

  // AUTHZ-2: the FIRST runtime User-write surface. Originally bounded to
  // the platform-tier invitation flow (apps/platform-admin) after Cognito
  // AdminCreateUser returned the Cognito sub.
  //
  // Settings S3a (DUAL-TIER consumer): tenant tier (TenantUserLifecycleService)
  // + platform tier (PlatformInvitationService). The actor_user_id flows
  // through as the audit events' actor_id; the emitted audit events
  // (identity.user.created, identity.external_identity.linked,
  // identity.membership.created, identity.invitation.created) are unchanged
  // between tiers — the tenant_id on each event is enough to distinguish
  // the call site.
  //
  // D-AUTHZ-PLATFORM-INVITE-1 (in-service): role_keys + request_id are
  // threaded in so the D5 union-non-invertibility check runs HERE, BEFORE
  // the DB write and BEFORE any audit emission. Every caller is covered;
  // the prior caller-side contract is retired.
  async createUserFromInvitation(args: {
    email: string;
    display_name: string | null;
    provider: string;
    provider_subject: string;
    tenant_id: string;
    role_keys: readonly string[];
    role_ids: readonly string[];
    actor_user_id: string;
    request_id: string;
  }): Promise<{ user: UserDto; membership_id: string }> {
    // D5 integrity gate — in-service. No-ops at length<2; rejects an
    // invertible union with VALIDATION_ERROR (details.reason=
    // 'invertible_role_union'); see-all-tier bypass derived internally.
    await this.roleBundle.assertUnionNonInvertible({
      role_keys: args.role_keys,
      request_id: args.request_id,
    });

    const user_id = uuidv7();
    const result =
      await this.identityRepo.createUserWithExternalIdentityAndMembership({
        user_id,
        email: args.email,
        display_name: args.display_name,
        provider: args.provider,
        provider_subject: args.provider_subject,
        tenant_id: args.tenant_id,
        role_ids: args.role_ids,
      });

    // Audit emission — best-effort (the wrapper swallows failures + logs).
    // identity.user.created + identity.external_identity.linked are GLOBAL
    // events (tenant_id null per the EVENT_TYPES -> index-category mapping);
    // identity.membership.created + identity.invitation.created are tenant-
    // scoped (carry the invited-into tenant_id). The two split sites are
    // required by `assertMappingObeyed` in the audit repository.
    await this.audit.writeGlobalEvent({
      event_type: 'identity.user.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      subject_id: result.user.id,
      payload: { email: args.email, source: 'invitation' },
    });
    await this.audit.writeGlobalEvent({
      event_type: 'identity.external_identity.linked',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      subject_id: result.user.id,
      payload: {
        provider: args.provider,
        provider_subject: args.provider_subject,
      },
    });
    await this.audit.writeEvent({
      event_type: 'identity.membership.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: result.user.id,
      payload: { membership_id: result.membership_id },
    });
    await this.audit.writeEvent({
      event_type: 'identity.invitation.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: result.user.id,
      payload: {
        email: args.email,
        provider: args.provider,
        provider_subject: args.provider_subject,
        role_ids: [...args.role_ids],
      },
    });

    return { user: result.user, membership_id: result.membership_id };
  }

  // Invite-S2 (Pattern-2) — the NO-SUB invite create. The tenant-tier
  // federated-invite counterpart to createUserFromInvitation: it mirrors that
  // method MINUS the Cognito sub. No ExternalIdentity is written (no sub is
  // minted at invite time — it links at first federated login via the
  // reconcile spine, exactly as the seeded Astre owner already does), so the
  // identity.external_identity.linked audit event is NOT emitted here.
  //
  // The D5 union-non-invertibility gate runs HERE (REUSED as-is from
  // createUserFromInvitation), BEFORE the DB write and BEFORE any audit
  // emission — every multi-role invite is covered. On success it also issues
  // the Invitation token (hash persisted, raw returned ONCE for the email
  // link) and returns the new response shape (invitation_id + the raw token
  // for the caller's email step; the membership starts in invite_status
  // INVITED).
  async createInvitedUserNoSub(args: {
    email: string;
    display_name: string | null;
    tenant_id: string;
    role_keys: readonly string[];
    role_ids: readonly string[];
    actor_user_id: string;
    request_id: string;
  }): Promise<{
    user: UserDto;
    membership_id: string;
    invitation_id: string;
    raw_token: string;
    expires_at: string;
  }> {
    // D5 integrity gate — in-service. No-ops at length<2; rejects an
    // invertible union with VALIDATION_ERROR before any write.
    await this.roleBundle.assertUnionNonInvertible({
      role_keys: args.role_keys,
      request_id: args.request_id,
    });

    const user_id = uuidv7();
    const result = await this.identityRepo.createUserWithMembership({
      user_id,
      email: args.email,
      display_name: args.display_name,
      tenant_id: args.tenant_id,
      role_ids: args.role_ids,
    });

    // Issue the invite token (mirror RefreshToken: hash at rest, raw once).
    const { raw, hash } = generateInvitationToken();
    const expires_at = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await this.identityRepo.createInvitation({
      user_id,
      tenant_id: args.tenant_id,
      membership_id: result.membership_id,
      token_hash: hash,
      expires_at,
    });

    // Audit emission — best-effort (the wrapper swallows failures + logs).
    // identity.user.created is GLOBAL; membership.created + invitation.created
    // are tenant-scoped. NO identity.external_identity.linked (no sub minted).
    await this.audit.writeGlobalEvent({
      event_type: 'identity.user.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      subject_id: result.user.id,
      payload: { email: args.email, source: 'invitation' },
    });
    await this.audit.writeEvent({
      event_type: 'identity.membership.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: result.user.id,
      payload: { membership_id: result.membership_id },
    });
    await this.audit.writeEvent({
      event_type: 'identity.invitation.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: result.user.id,
      payload: {
        email: args.email,
        invitation_id: invitation.id,
        role_ids: [...args.role_ids],
        flow: 'pattern2_federated',
      },
    });

    return {
      user: result.user,
      membership_id: result.membership_id,
      invitation_id: invitation.id,
      raw_token: raw,
      expires_at: invitation.expires_at,
    };
  }

  // Invite-S2 — the ACCEPT primitive behind the public acceptance endpoint.
  // Validates the URL-supplied raw token by its stored hash, enforces the
  // single-use / expiry / revoke invariants (each a CLEAR 4xx, never a 500),
  // then atomically stamps accepted_at + flips the membership INVITED →
  // ACCEPTED and emits identity.invitation.accepted. It issues NO session and
  // forces NO sign-in — it returns the context the lifecycle service needs to
  // send the acceptance-confirmation email. Identity-writes stay here in
  // libs/identity; the public controller + the email send live one layer out.
  async acceptInvitationByToken(args: {
    raw_token: string;
    request_id: string;
  }): Promise<{
    invitation_id: string;
    user_id: string;
    membership_id: string;
    tenant_id: string;
    role_keys: string[];
    email: string;
    tenant_name: string;
    tenant_display_name: string | null;
  }> {
    const invalid = (reason: string): AramoError =>
      new AramoError(
        'VALIDATION_ERROR',
        'invitation is invalid or expired',
        400,
        { requestId: args.request_id, details: { reason } },
      );

    const token = (args.raw_token ?? '').trim();
    if (token.length === 0) throw invalid('missing_token');

    const hash = hashInvitationToken(token);
    const invitation = await this.identityRepo.findInvitationByHash(hash);
    if (invitation === null) throw invalid('invalid_token');
    if (invitation.revoked_at !== null) throw invalid('revoked');
    if (invitation.accepted_at !== null) throw invalid('already_accepted');
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw invalid('expired');
    }

    const accepted_at = new Date();
    await this.identityRepo.acceptInvitationTx({
      invitation_id: invitation.id,
      membership_id: invitation.membership_id,
      accepted_at,
    });

    // Platform-Console Increment-2 PR-1 (R10) — resolve the accepted membership's
    // role keys so (a) the identity.invitation.accepted payload is enriched with
    // tenant_id + role_keys, and (b) the caller (InvitationLifecycleService) can
    // fire the inline tenant activation only for a tenant_owner acceptance.
    const role_keys = await this.identityRepo.findRoleKeysForMembership(
      invitation.membership_id,
    );

    await this.audit.writeEvent({
      event_type: 'identity.invitation.accepted',
      actor_type: 'user',
      actor_id: invitation.user_id,
      tenant_id: invitation.tenant_id,
      subject_id: invitation.user_id,
      payload: {
        invitation_id: invitation.id,
        membership_id: invitation.membership_id,
        tenant_id: invitation.tenant_id,
        role_keys,
      },
    });

    // Reads for the confirmation email (best-effort labels; the accept itself
    // already committed). A missing user/tenant degrades the email greeting,
    // never the acceptance.
    const user = await this.identityRepo.findUserById(invitation.user_id);
    const tenant = await this.identityRepo.findTenantNameById(invitation.tenant_id);

    return {
      invitation_id: invitation.id,
      user_id: invitation.user_id,
      membership_id: invitation.membership_id,
      tenant_id: invitation.tenant_id,
      role_keys,
      email: user?.email ?? '',
      tenant_name: tenant?.name ?? 'your workspace',
      tenant_display_name: tenant?.display_name ?? null,
    };
  }

  // Invite-S2 — the tenant label for the invite email greeting: the branding
  // display_name, falling back to the workspace name (same precedence as
  // GET /v1/me), and a neutral default for an unknown tenant.
  async getTenantLabel(tenant_id: string): Promise<string> {
    const t = await this.identityRepo.findTenantNameById(tenant_id);
    return t?.display_name ?? t?.name ?? 'your workspace';
  }

  // Domain-Enforcement P1 — the invite domain-lock loads the tenant's locked
  // domain through here. null = unset (legacy) or unknown tenant → the lock
  // allows through (NULL never occurs for a real tenant once provision sets
  // it + Astre is backfilled).
  async getTenantAllowedDomain(tenant_id: string): Promise<string | null> {
    return this.identityRepo.findTenantAllowedDomainById(tenant_id);
  }

  // People&Access activation-on-sign-in fix — THE SINGLE membership-activation
  // seam. The session-orchestrator calls this on EVERY authenticated session
  // (both by-sub HIT and MISS), so a user who reaches first sign-in by-sub HIT
  // — their Cognito sub was linked before the membership was accepted — is
  // activated too. It replaces the original link-coupled ACTIVE-hook, which
  // fired only on the one-time sub-link and so left by-sub-HIT users stuck at
  // ACCEPTED. Strict + idempotent: ONLY ACCEPTED→ACTIVE on an active
  // membership; never INVITED, never disabled, never a downgrade.
  async activateAcceptedMembershipsOnSession(args: {
    user_id: string;
  }): Promise<{ activated: number }> {
    return this.identityRepo.activateAcceptedMembershipsForUser(args.user_id);
  }

  // Invite-S2 — admin revoke of a still-pending invite (§4.3 backend method;
  // the FE action is S3). Idempotent at the repo (already-revoked / accepted
  // invites are not re-stamped). Returns whether a row changed.
  async revokeInvitation(args: {
    invitation_id: string;
  }): Promise<{ changed: boolean }> {
    return this.identityRepo.revokeInvitation({
      invitation_id: args.invitation_id,
      revoked_at: new Date(),
    });
  }

  // Invite-S3 — resolve the active invitation for a user in a tenant (the S3
  // admin actions key on user_id, with no invitation_id on the roster row).
  async findActiveInvitation(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<InvitationDto | null> {
    return this.identityRepo.findActiveInvitationByUserAndTenant(args);
  }

  // Invite-S3 (§4.3) — rotate an invitation's token. Mints a fresh token
  // (hash at rest, raw returned ONCE for the resend email link, mirroring the
  // create path), resets the 7-day TTL, and clears accepted_at/revoked_at so
  // the invite is live-pending again. Returns the raw token + the new expiry.
  async rotateInvitationToken(args: {
    invitation_id: string;
  }): Promise<{ raw_token: string; expires_at: string }> {
    const { raw, hash } = generateInvitationToken();
    const expires_at = new Date(Date.now() + INVITATION_TTL_MS);
    await this.identityRepo.rotateInvitationToken({
      invitation_id: args.invitation_id,
      token_hash: hash,
      expires_at,
    });
    return { raw_token: raw, expires_at: expires_at.toISOString() };
  }

  // Invite-S3 (§4.4) — mutate User.email (the FAILED-only edit path). The
  // FAILED-only precondition is enforced by the caller (lifecycle service); a
  // @unique collision propagates as the Prisma error the caller maps to a 4xx.
  async updateUserEmail(args: {
    user_id: string;
    email: string;
  }): Promise<void> {
    await this.identityRepo.updateUserEmail(args);
  }

  // AUTHZ-2: the new-tenant re-invite case (Lead ruling 8 case 3). The
  // invitee already has identity.User + ExternalIdentity (in Cognito and
  // mirrored); the invitation only needs a new UserTenantMembership +
  // MembershipRole rows.
  //
  // D-AUTHZ-PLATFORM-INVITE-1 (in-service): role_keys + request_id threaded
  // for the D5 gate (fires BEFORE the membership-existence check and the
  // DB write).
  async addMembershipForExistingUser(args: {
    user_id: string;
    tenant_id: string;
    role_keys: readonly string[];
    role_ids: readonly string[];
    actor_user_id: string;
    request_id: string;
  }): Promise<{ membership_id: string }> {
    // D5 integrity gate — in-service. Fires BEFORE the existence check so
    // an invertible bundle is rejected without revealing whether the
    // membership already exists (consistent with the role-assign
    // ordering at S3b).
    await this.roleBundle.assertUnionNonInvertible({
      role_keys: args.role_keys,
      request_id: args.request_id,
    });

    const existing = await this.identityRepo.findMembership({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });
    if (existing !== null) {
      throw new AramoError(
        'INVITATION_ALREADY_EXISTS',
        'User already holds a membership in this tenant',
        409,
        {
          requestId: args.request_id,
          details: {
            user_id: args.user_id,
            tenant_id: args.tenant_id,
            existing_membership_id: existing.id,
          },
        },
      );
    }
    const result = await this.identityRepo.createMembershipForExistingUser({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
      role_ids: args.role_ids,
    });
    await this.audit.writeEvent({
      event_type: 'identity.membership.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: args.user_id,
      payload: { membership_id: result.membership_id },
    });
    await this.audit.writeEvent({
      event_type: 'identity.invitation.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: args.user_id,
      payload: {
        role_ids: [...args.role_ids],
        reason: 'new_tenant_for_existing_user',
      },
    });
    return result;
  }

  // AUTHZ-2: same-tenant role replacement (Lead ruling 8 case 2). The
  // membership row stays; the role junction is reconciled.
  //
  // D-AUTHZ-PLATFORM-INVITE-1 (in-service): role_keys + request_id threaded
  // for the D5 gate (fires BEFORE the reconcile so an invertible union
  // never reaches the createMany/deleteMany inside the $transaction).
  async replaceMembershipRoles(args: {
    membership_id: string;
    role_keys: readonly string[];
    role_ids: readonly string[];
    request_id: string;
  }): Promise<{ added_role_ids: string[]; removed_role_ids: string[] }> {
    await this.roleBundle.assertUnionNonInvertible({
      role_keys: args.role_keys,
      request_id: args.request_id,
    });

    return this.identityRepo.replaceMembershipRoles({
      membership_id: args.membership_id,
      role_ids: args.role_ids,
    });
  }

  async resolveRoleIdsByKeys(role_keys: readonly string[]): Promise<string[]> {
    const map = await this.identityRepo.findRoleIdsByKeys(role_keys);
    const missing = role_keys.filter((k) => !map.has(k));
    if (missing.length > 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Unknown role key(s)',
        400,
        { requestId: 'invitation', details: { missing_role_keys: missing } },
      );
    }
    return role_keys.map((k) => map.get(k)!);
  }

  async findRoleIdsForMembership(membership_id: string): Promise<string[]> {
    return this.identityRepo.findRoleIdsForMembership(membership_id);
  }

  async findRoleKeysForMembership(membership_id: string): Promise<string[]> {
    return this.identityRepo.findRoleKeysForMembership(membership_id);
  }

  // Settings S3a — soft-disable a tenant membership. Identity-first leg
  // of the disable saga (the Cognito leg is the lifecycle service's job
  // because libs/identity does not import the AWS SDK; the controller's
  // saga calls this, then the Cognito port, then compensates via
  // reEnableMembership on Cognito failure).
  //
  // Returns the prior state so the saga can decide whether to emit the
  // identity.tenant_user.disabled audit event (only on a true→false
  // transition; an idempotent re-disable suppresses emission per the
  // S2 no-op-no-audit precedent) and whether to invoke the Cognito
  // disable (only when changed=true; an already-disabled membership
  // means Cognito was already toggled on the prior disable).
  async disableMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<
    | { changed: true; membership_id: string }
    | { changed: false; membership_id: string; already_disabled: true }
    | null
  > {
    const result = await this.identityRepo.disableMembership({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });
    if (result === null) return null;
    if (result.changed === true) {
      return { changed: true, membership_id: result.membership_id };
    }
    return {
      changed: false,
      membership_id: result.membership_id,
      already_disabled: true,
    };
  }

  // Settings S3a — re-enable compensation. Invoked by the lifecycle
  // saga ONLY when the Cognito disable leg fails after the identity
  // flip committed; restores is_active=true and clears deactivated_at.
  // Idempotent.
  async reEnableMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<{ membership_id: string } | null> {
    return this.identityRepo.reEnableMembership({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });
  }
}
