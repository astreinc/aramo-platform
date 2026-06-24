import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { ExternalIdentityDto } from './dto/external-identity.dto.js';
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
  tenant: { display_name: string };
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
      tenant: { display_name: ctx.tenant_display_name ?? ctx.tenant_name },
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
