import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { ExternalIdentityDto } from './dto/external-identity.dto.js';
import type { InvitationDto } from './dto/invitation.dto.js';
import type { MembershipDto } from './dto/membership.dto.js';
import type { UserDto } from './dto/user.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for User / ExternalIdentity reads + (AUTHZ-2) the FIRST
// runtime User-write path.
//
// Pre-AUTHZ-2: resolve-only — the repository never created a User row at
// runtime (the original §3 + §11 halt condition).
//
// AUTHZ-2 (Lead ruling 9): the create surface is added BUT bounded.
// createUserWithExternalIdentityAndMembership is the atomic identity-tx
// emitted by the platform-tier invitation flow (Pattern A: Cognito-first
// AdminCreateUser -> mirror to identity). It is invoked ONLY from
// apps/platform-admin (the Nx boundary asserts this); the existing
// resolve path (findUserByExternalIdentity) is untouched and remains the
// auth-service /callback seam. The §5 step 8 regression proof guards that
// the resolve consumers (auth-service SessionOrchestrator + the tenant-
// facing apps/api) see no behavior change.
@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Looks up the (provider, provider_subject) pair via the ExternalIdentity
  // unique index, hydrates the linked User. Returns null when no mapping.
  async findUserByExternalIdentity(args: {
    provider: string;
    provider_subject: string;
  }): Promise<UserDto | null> {
    const row = await this.prisma.externalIdentity.findUnique({
      where: {
        provider_provider_subject: {
          provider: args.provider,
          provider_subject: args.provider_subject,
        },
      },
      include: { user: true },
    });
    if (row === null) {
      return null;
    }
    return toUserDto(row.user);
  }

  async findExternalIdentity(args: {
    provider: string;
    provider_subject: string;
  }): Promise<ExternalIdentityDto | null> {
    const row = await this.prisma.externalIdentity.findUnique({
      where: {
        provider_provider_subject: {
          provider: args.provider,
          provider_subject: args.provider_subject,
        },
      },
    });
    if (row === null) {
      return null;
    }
    return toExternalIdentityDto(row);
  }

  // AUTH-HARD / M7 primitive — link an external IdP identity (e.g. Cognito) to
  // a PRE-EXISTING identity.User. Distinct from
  // createUserWithExternalIdentityAndMembership (which CREATES the User in one
  // tx): this attaches a (provider, provider_subject) pair to a user that was
  // already provisioned by some other path (invitation seed, federated-login
  // reconcile). Idempotent upsert on the [provider, provider_subject] unique
  // key — a re-run with the same pair is a no-op that returns the existing row
  // unchanged (the user_id/email_snapshot are NOT rewritten). The id is
  // generated app-side (uuid v7) to match the existing create site.
  async linkExternalIdentity(args: {
    provider: string;
    provider_subject: string;
    user_id: string;
    email_snapshot: string | null;
  }): Promise<ExternalIdentityDto> {
    const row = await this.prisma.externalIdentity.upsert({
      where: {
        provider_provider_subject: {
          provider: args.provider,
          provider_subject: args.provider_subject,
        },
      },
      update: {},
      create: {
        id: uuidv7(),
        provider: args.provider,
        provider_subject: args.provider_subject,
        user_id: args.user_id,
        email_snapshot: args.email_snapshot,
      },
    });
    return toExternalIdentityDto(row);
  }

  async findUserByEmail(email: string): Promise<UserDto | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row === null ? null : toUserDto(row);
  }

  // Settings S3a — needed by TenantUserLifecycleService to derive the
  // Cognito Username (Aramo's Cognito convention is Username=email; see
  // apps/platform-admin/src/app/platform/cognito/cognito-admin.service.ts)
  // from the URL-supplied user_id at disable. Returns null when the user
  // has been hard-deleted (so the controller maps to NOT_FOUND).
  async findUserById(user_id: string): Promise<UserDto | null> {
    const row = await this.prisma.user.findUnique({ where: { id: user_id } });
    return row === null ? null : toUserDto(row);
  }

  // Invite-S2 — minimal tenant label read for the invite/acceptance emails.
  // Returns the workspace `name` + the optional branding `display_name`
  // (the email greeting prefers display_name and falls back to name, the
  // same precedence GET /v1/me uses). Returns null for an unknown tenant.
  async findTenantNameById(
    tenant_id: string,
  ): Promise<{ name: string; display_name: string | null } | null> {
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenant_id },
      select: { name: true, display_name: true },
    });
    return row === null ? null : { name: row.name, display_name: row.display_name };
  }

  // Domain-Enforcement P1 — the invite domain-lock reads this. Returns the
  // tenant's normalized allowed_domain, or null for an unset (legacy) or
  // unknown tenant (both → allow-through at the lock).
  async findTenantAllowedDomainById(
    tenant_id: string,
  ): Promise<string | null> {
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenant_id },
      select: { allowed_domain: true },
    });
    return row?.allowed_domain ?? null;
  }

  async findMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<MembershipDto | null> {
    const row = await this.prisma.userTenantMembership.findUnique({
      where: {
        user_id_tenant_id: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      },
    });
    return row === null ? null : toMembershipDto(row);
  }

  // Settings S5-BE1 — tenant-users list (the user-roster the S5b admin view
  // renders). Returns every membership in the tenant (active AND disabled
  // both surface; the directive (c) proof requires the S3a soft-disable
  // state to be visible at the read). Each row carries identity (email +
  // display_name) + membership-level state (is_active + deactivated_at —
  // the membership soft-disable columns the S3a saga writes, NOT
  // User.is_active which is the global flag) + site_id (PR-A1a Ruling 4,
  // nullable) + role_keys (sorted asc; only active roles surface — matches
  // findRoleKeysForMembership's precedent so the read shape is consistent
  // with what S3b's audit payloads carry).
  //
  // Per-tenant isolation: WHERE clause filters on tenant_id ONLY. The
  // controller derives tenant_id from authContext (never from the body),
  // so a tenant_admin in tenant A reads only tenant A's roster.
  //
  // Order: (joined_at asc, user_id asc) — stable for the UI; matches the
  // intuition that newer-joined users appear later. No pagination (S5-BE1
  // lean — matches the requisition list precedent).
  async listTenantUsers(tenant_id: string): Promise<TenantUserView[]> {
    const rows = await this.prisma.userTenantMembership.findMany({
      where: { tenant_id },
      include: {
        user: true,
        role_assignments: {
          where: { role: { is_active: true } },
          include: { role: { select: { key: true } } },
        },
      },
      orderBy: [{ joined_at: 'asc' }, { user_id: 'asc' }],
    });
    return rows.map(toTenantUserView);
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — resolve a tenant's OWNER (the
  // user holding an active tenant_owner-role membership) → { user_id, email }.
  // Used by resend-owner-invite to address the Cognito re-send. findFirst
  // ordered by joined_at asc so the original owner wins if (edge case) more than
  // one tenant_owner membership ever exists. Null when the tenant has no
  // tenant_owner membership (a data-integrity fault for a PROVISIONED tenant —
  // the caller maps null to a clear error rather than silently no-op).
  async findTenantOwner(
    tenant_id: string,
  ): Promise<{ user_id: string; email: string } | null> {
    const row = await this.prisma.userTenantMembership.findFirst({
      where: {
        tenant_id,
        is_active: true,
        role_assignments: {
          some: { role: { key: 'tenant_owner', is_active: true } },
        },
      },
      select: { user_id: true, user: { select: { email: true } } },
      orderBy: [{ joined_at: 'asc' }, { user_id: 'asc' }],
    });
    return row === null ? null : { user_id: row.user_id, email: row.user.email };
  }

  // §5 Auth-Hardening D4 — the recruiter-scoped ASSIGNABLE roster (minimal).
  //
  // The LEAST-DATA counterpart to listTenantUsers: a deliberately narrow
  // roster for the assignment pickers (assign a task / requisition / pod to a
  // teammate). It projects ONLY user_id + display_name — the bare minimum to
  // pick a teammate. NO email, NO membership status detail, NO roles/scopes,
  // NO site, NO audit. None of the admin UserView is needed to assign work, so
  // none is served (and none can leak — this is a distinct, strictly-narrower
  // projection, NOT a re-gated TenantUserView).
  //
  // ACTIVE memberships only (is_active = true — the S3a soft-disable flag): a
  // disabled user cannot be assigned to, so they are EXCLUDED (not surfaced as
  // "disabled"). Tenant-scoped (WHERE tenant_id, from authContext — never a
  // param). Ordered display_name asc then user_id asc — a plain ALPHABETICAL
  // roster. R10: the order carries NO match/fit/quality verdict on the person.
  async listAssignableTenantUsers(
    tenant_id: string,
  ): Promise<AssignableUserView[]> {
    const rows = await this.prisma.userTenantMembership.findMany({
      where: { tenant_id, is_active: true },
      select: { user_id: true, user: { select: { display_name: true } } },
      orderBy: [{ user: { display_name: 'asc' } }, { user_id: 'asc' }],
    });
    return rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.user.display_name,
    }));
  }

  // §5 Auth-Hardening D4 — the CLIENT-FILTERED assignable roster (the
  // requisition-assignment picker). The identity half of the cross-schema
  // composition: given the set of user_ids mapped to a client (resolved at
  // apps/api from company.UserClientAssignment — libs/identity must not import
  // the company schema) and the req-carrying role keys, return the MINIMAL
  // roster of ACTIVE members in this tenant who are BOTH client-mapped AND
  // hold a req-carrying role (Recruiter / Recruiter Lead). Same least-data
  // projection + alphabetical (R10-neutral) order as listAssignableTenantUsers.
  // Empty user_ids or role_keys → [] (a client with no mapped recruiters
  // yields an empty picker, not all-tenant).
  async listAssignableTenantUsersByIdsAndRoles(args: {
    tenant_id: string;
    user_ids: readonly string[];
    role_keys: readonly string[];
  }): Promise<AssignableUserView[]> {
    if (args.user_ids.length === 0 || args.role_keys.length === 0) return [];
    const rows = await this.prisma.userTenantMembership.findMany({
      where: {
        tenant_id: args.tenant_id,
        is_active: true,
        user_id: { in: Array.from(args.user_ids) },
        role_assignments: {
          some: {
            role: { key: { in: Array.from(args.role_keys) }, is_active: true },
          },
        },
      },
      select: { user_id: true, user: { select: { display_name: true } } },
      orderBy: [{ user: { display_name: 'asc' } }, { user_id: 'asc' }],
    });
    return rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.user.display_name,
    }));
  }

  // §5 Auth-Hardening D4b — the name-resolver directory. Resolves user_id →
  // display_name for ANY user with a membership in this tenant, INCLUDING
  // INACTIVE/DEPARTED ones — the historical-integrity requirement (a record's
  // author/owner/assignee must still render their name after they leave). This
  // is the deliberate counterpart to listAssignableTenantUsers, which excludes
  // inactive by design: here there is NO is_active filter on the membership.
  //
  // Pure-identity (UserTenantMembership ⋈ User) — no company schema. Minimal
  // {user_id, display_name} only (a name lookup, not the admin view: no email/
  // status/roles/audit). @@unique(user_id, tenant_id) → one row per user, no
  // dedup. Optional user_ids → the BATCH form (a list view resolving N rows in
  // one call); absent → the whole tenant directory. Tenant-scoped (WHERE
  // tenant_id, never a param). Empty user_ids (an explicit empty batch) → [].
  // R10: alphabetical, no person-verdict.
  async listTenantUserDirectory(args: {
    tenant_id: string;
    user_ids?: readonly string[];
  }): Promise<DirectoryUserView[]> {
    if (args.user_ids !== undefined && args.user_ids.length === 0) return [];
    const rows = await this.prisma.userTenantMembership.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.user_ids !== undefined
          ? { user_id: { in: Array.from(args.user_ids) } }
          : {}),
      },
      select: { user_id: true, user: { select: { display_name: true } } },
      orderBy: [{ user: { display_name: 'asc' } }, { user_id: 'asc' }],
    });
    return rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.user.display_name,
    }));
  }

  // Settings S5-BE1 — tenant-user detail. Same shape as a list row, single
  // row. Returns null when no membership for (user_id, tenant_id) — the
  // controller maps null → 404 NOT_FOUND. Per-tenant isolation: a
  // `:user_id` belonging to a user without a membership in this tenant
  // returns null (NOT a leaked row from another tenant — the WHERE is on
  // the composite key user_id_tenant_id).
  async getTenantUser(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<TenantUserView | null> {
    const row = await this.prisma.userTenantMembership.findUnique({
      where: {
        user_id_tenant_id: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      },
      include: {
        user: true,
        role_assignments: {
          where: { role: { is_active: true } },
          include: { role: { select: { key: true } } },
        },
      },
    });
    return row === null ? null : toTenantUserView(row);
  }

  async findRoleIdsForMembership(membership_id: string): Promise<string[]> {
    const rows = await this.prisma.userTenantMembershipRole.findMany({
      where: { membership_id },
      select: { role_id: true },
    });
    return rows.map((r) => r.role_id);
  }

  // Aramo-Identity-Me-Endpoint — the self-read behind GET /v1/me. Resolves the
  // caller's membership in this tenant and joins through to the User (email +
  // display_name), the membership's ACTIVE roles (key + description, for the
  // display-name resolution in the service — mirrors getTenantUser's
  // active-roles-only filter), and the Tenant (name + display_name, for the org
  // label). Keyed on the composite (user_id, tenant_id) from the JWT — a member
  // of tenant A can never read tenant B (no membership row → null → 404). Returns
  // null when no membership exists for the pair (e.g. a stale token after the
  // membership was removed).
  async findMeContext(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<MeContextRow | null> {
    const row = await this.prisma.userTenantMembership.findUnique({
      where: {
        user_id_tenant_id: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      },
      include: {
        user: { select: { email: true, display_name: true } },
        tenant: { select: { name: true, display_name: true } },
        role_assignments: {
          where: { role: { is_active: true } },
          include: { role: { select: { key: true, description: true } } },
        },
      },
    });
    if (row === null) return null;
    return {
      email: row.user.email,
      display_name: row.user.display_name,
      roles: row.role_assignments.map((ra) => ({
        key: ra.role.key,
        description: ra.role.description,
      })),
      tenant_name: row.tenant.name,
      tenant_display_name: row.tenant.display_name,
    };
  }

  // Settings S3b — needed by TenantUserLifecycleService.assignTenantUserRoles
  // for the before/after role-key audit payloads (role KEYS, not IDs, so the
  // change-log row is human-readable). Joins through Role to project the key
  // column; only active role assignments are returned (an inactive role's
  // scopes already do not resolve at session-issuance time per RoleRepository
  // .findScopeKeysForUserInTenant). Deterministic order (asc).
  async findRoleKeysForMembership(membership_id: string): Promise<string[]> {
    const rows = await this.prisma.userTenantMembershipRole.findMany({
      where: { membership_id, role: { is_active: true } },
      select: { role: { select: { key: true } } },
    });
    return rows.map((r) => r.role.key).sort();
  }

  async findRoleIdsByKeys(role_keys: readonly string[]): Promise<Map<string, string>> {
    if (role_keys.length === 0) return new Map();
    const rows = await this.prisma.role.findMany({
      where: { key: { in: [...role_keys] }, is_active: true },
      select: { id: true, key: true },
    });
    return new Map(rows.map((r) => [r.key, r.id]));
  }

  // AUTHZ-2: the atomic identity-tx for the invitation flow's mirror step.
  // Writes User + ExternalIdentity + UserTenantMembership +
  // UserTenantMembershipRole[] in a single transaction. The membership_id
  // and external_identity_id are generated app-side (uuid v7) so callers
  // can audit the row IDs deterministically.
  async createUserWithExternalIdentityAndMembership(args: {
    user_id: string;
    email: string;
    display_name: string | null;
    provider: string;
    provider_subject: string;
    tenant_id: string;
    role_ids: readonly string[];
  }): Promise<{
    user: UserDto;
    external_identity_id: string;
    membership_id: string;
    membership_role_ids: string[];
  }> {
    const external_identity_id = uuidv7();
    const membership_id = uuidv7();
    const membership_role_ids = args.role_ids.map(() => uuidv7());

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: args.user_id,
          email: args.email,
          display_name: args.display_name,
        },
      });
      await tx.externalIdentity.create({
        data: {
          id: external_identity_id,
          provider: args.provider,
          provider_subject: args.provider_subject,
          user_id: args.user_id,
          email_snapshot: args.email,
        },
      });
      await tx.userTenantMembership.create({
        data: {
          id: membership_id,
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      });
      if (args.role_ids.length > 0) {
        await tx.userTenantMembershipRole.createMany({
          data: args.role_ids.map((role_id, idx) => ({
            id: membership_role_ids[idx]!,
            membership_id,
            role_id,
          })),
        });
      }
      return {
        user: toUserDto(user),
        external_identity_id,
        membership_id,
        membership_role_ids,
      };
    });
  }

  // AUTHZ-2: bind an additional UserTenantMembership for an existing User
  // (the new-tenant re-invite case from Lead ruling 8 case 3). Reused by
  // the invitation service when AdminGetUser confirms the Cognito user
  // exists + identity.User exists, but the invitee has no membership in
  // the target tenant yet.
  async createMembershipForExistingUser(args: {
    user_id: string;
    tenant_id: string;
    role_ids: readonly string[];
  }): Promise<{ membership_id: string; membership_role_ids: string[] }> {
    const membership_id = uuidv7();
    const membership_role_ids = args.role_ids.map(() => uuidv7());

    await this.prisma.$transaction(async (tx) => {
      await tx.userTenantMembership.create({
        data: {
          id: membership_id,
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      });
      if (args.role_ids.length > 0) {
        await tx.userTenantMembershipRole.createMany({
          data: args.role_ids.map((role_id, idx) => ({
            id: membership_role_ids[idx]!,
            membership_id,
            role_id,
          })),
        });
      }
    });
    return { membership_id, membership_role_ids };
  }

  // Invite-S2 (Pattern-2) — the no-sub identity-tx for the federated invite
  // flow. Mirrors createUserWithExternalIdentityAndMembership MINUS the
  // ExternalIdentity write: the Cognito sub is NOT minted at invite time
  // (it is linked at first federated login by the reconcile spine, exactly
  // as the seed + the seeded Astre owner already do). Single tx:
  //   User (no ExternalIdentity)
  //   + UserTenantMembership (invite_status = INVITED)
  //   + UserTenantMembershipRole[].
  // The membership_id and role-assignment ids are generated app-side (uuid
  // v7) so the caller can audit the row ids deterministically.
  async createUserWithMembership(args: {
    user_id: string;
    email: string;
    display_name: string | null;
    tenant_id: string;
    role_ids: readonly string[];
  }): Promise<{
    user: UserDto;
    membership_id: string;
    membership_role_ids: string[];
  }> {
    const membership_id = uuidv7();
    const membership_role_ids = args.role_ids.map(() => uuidv7());

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: args.user_id,
          email: args.email,
          display_name: args.display_name,
        },
      });
      await tx.userTenantMembership.create({
        data: {
          id: membership_id,
          user_id: args.user_id,
          tenant_id: args.tenant_id,
          invite_status: 'INVITED',
        },
      });
      if (args.role_ids.length > 0) {
        await tx.userTenantMembershipRole.createMany({
          data: args.role_ids.map((role_id, idx) => ({
            id: membership_role_ids[idx]!,
            membership_id,
            role_id,
          })),
        });
      }
      return {
        user: toUserDto(user),
        membership_id,
        membership_role_ids,
      };
    });
  }

  // Invite-S2 — persist a fresh Invitation token row. token_hash is the
  // sha256·base64url of the raw token (never the raw token). The id is
  // generated app-side (uuid v7) so the caller can return invitation_id in
  // the invite response. expires_at is computed app-side at issue time.
  async createInvitation(args: {
    user_id: string;
    tenant_id: string;
    membership_id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<InvitationDto> {
    const row = await this.prisma.invitation.create({
      data: {
        id: uuidv7(),
        user_id: args.user_id,
        tenant_id: args.tenant_id,
        membership_id: args.membership_id,
        token_hash: args.token_hash,
        expires_at: args.expires_at,
      },
    });
    return toInvitationDto(row);
  }

  // Invite-S2 — single-indexed lookup by the @unique token_hash. Returns null
  // when no invite matches (the acceptance endpoint maps that to a 4xx, never
  // a 500). Does NOT enforce expiry/accepted/revoked — that is the lifecycle
  // service's validation (so it can return distinct reasons).
  async findInvitationByHash(token_hash: string): Promise<InvitationDto | null> {
    const row = await this.prisma.invitation.findUnique({
      where: { token_hash },
    });
    return row === null ? null : toInvitationDto(row);
  }

  // Invite-S3 — resolve the active invitation for a (user_id, tenant_id) pair.
  // The S3 admin actions (revoke / resend / edit-email) key on user_id, so the
  // service must find the invitation WITHOUT an invitation_id on the roster row
  // (Audit Finding 5). The no-sub invite flow creates exactly one Invitation
  // per membership and resend ROTATES it in place (UPDATE, not insert), so a
  // membership has at most one row; the most-recently-created is returned to be
  // robust against any future multi-row history. Returns null when the user has
  // no invitation in this tenant (e.g. a seeded ACTIVE owner) — the caller maps
  // that to a clear 4xx for the resend/revoke "no pending invite" case.
  async findActiveInvitationByUserAndTenant(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<InvitationDto | null> {
    const row = await this.prisma.invitation.findFirst({
      where: { user_id: args.user_id, tenant_id: args.tenant_id },
      orderBy: { created_at: 'desc' },
    });
    return row === null ? null : toInvitationDto(row);
  }

  // Invite-S3 (§4.3) — rotate an invitation's token IN PLACE. Resend re-issues
  // a fresh high-entropy token (new token_hash) and resets the TTL; it also
  // clears accepted_at + revoked_at so the row returns to a clean pending state
  // (the recovery path: a revoked-then-re-enabled invite, or a FAILED invite
  // re-sent post-email-edit, becomes a live pending invite again). An UPDATE on
  // existing columns — no schema change. Returns nothing; the caller already
  // holds the raw token to email.
  async rotateInvitationToken(args: {
    invitation_id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<void> {
    await this.prisma.invitation.update({
      where: { id: args.invitation_id },
      data: {
        token_hash: args.token_hash,
        expires_at: args.expires_at,
        accepted_at: null,
        revoked_at: null,
      },
    });
  }

  // Invite-S3 (§4.4) — mutate User.email (write-once at create until the
  // FAILED-only edit path opens it). The email is the @unique reconcile
  // identity; a collision with an existing user surfaces as a Prisma P2002
  // which the lifecycle service maps to a clear 4xx (email_in_use). The caller
  // (lifecycle service) enforces the FAILED-only precondition BEFORE this runs.
  async updateUserEmail(args: { user_id: string; email: string }): Promise<void> {
    await this.prisma.user.update({
      where: { id: args.user_id },
      data: { email: args.email },
    });
  }

  // Invite-S2 — ACCEPT transaction. Stamps the invite's accepted_at (single-
  // use) AND flips the membership INVITED → ACCEPTED, atomically. The
  // membership update is guarded on invite_status='INVITED' so a concurrent
  // or repeat accept cannot regress an already-ACTIVE membership; the
  // invitation accepted_at guard (checked by the caller before this runs) is
  // the load-bearing single-use gate. accepted_at is passed in so the row and
  // the audit event agree on the timestamp.
  async acceptInvitationTx(args: {
    invitation_id: string;
    membership_id: string;
    accepted_at: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: args.invitation_id },
        data: { accepted_at: args.accepted_at },
      });
      await tx.userTenantMembership.updateMany({
        where: { id: args.membership_id, invite_status: 'INVITED' },
        data: { invite_status: 'ACCEPTED' },
      });
    });
  }

  // Invite-S2 — admin revoke of a still-pending invite. Idempotent: a re-
  // revoke (already revoked) leaves revoked_at unchanged. Returns the row
  // count touched so the caller can report whether it changed anything.
  async revokeInvitation(args: {
    invitation_id: string;
    revoked_at: Date;
  }): Promise<{ changed: boolean }> {
    const res = await this.prisma.invitation.updateMany({
      where: { id: args.invitation_id, revoked_at: null, accepted_at: null },
      data: { revoked_at: args.revoked_at },
    });
    return { changed: res.count > 0 };
  }

  // People&Access activation-on-sign-in fix — THE SINGLE membership-activation
  // write. The session-orchestrator calls this on EVERY authenticated session
  // establishment (both by-sub HIT and MISS). It replaces the original
  // link-coupled hook, which fired only when the federated sub was FIRST linked
  // and so left every user whose Cognito sub was already linked at sign-in stuck
  // at ACCEPTED. Strict (per the Lead ruling): it flips ONLY ACCEPTED → ACTIVE
  // and ONLY for a still-active membership (is_active=true) — never an INVITED
  // (un-accepted) row, never a disabled (is_active=false) row, never a downgrade.
  // Idempotent: an already-ACTIVE row is not matched. Returns the count flipped.
  async activateAcceptedMembershipsForUser(
    user_id: string,
  ): Promise<{ activated: number }> {
    const res = await this.prisma.userTenantMembership.updateMany({
      where: { user_id, invite_status: 'ACCEPTED', is_active: true },
      data: { invite_status: 'ACTIVE' },
    });
    return { activated: res.count };
  }

  // Settings S3a — soft-disable a tenant membership (identity-first leg
  // of the disable saga). UPDATE-by-natural-key on (user_id, tenant_id);
  // idempotent (re-disable of an already-disabled membership returns
  // { changed: false, already_disabled: true } without re-stamping
  // deactivated_at). Returns the prior state so the lifecycle service
  // can decide whether to invoke the Cognito leg and whether to emit
  // an audit event. Returns null when no membership exists for the
  // (user_id, tenant_id) pair — the controller maps that to 404.
  //
  // Per-tenant isolation: the WHERE clause includes BOTH user_id AND
  // tenant_id, so a tenant_admin in tenant A cannot disable a user's
  // membership in tenant B even if the user_id were leaked (which it
  // can't be — the controller derives tenant_id from the session).
  async disableMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<
    | { changed: true; membership_id: string; previously_active: true }
    | { changed: false; membership_id: string; previously_active: false }
    | null
  > {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userTenantMembership.findUnique({
        where: {
          user_id_tenant_id: {
            user_id: args.user_id,
            tenant_id: args.tenant_id,
          },
        },
        select: { id: true, is_active: true },
      });
      if (existing === null) return null;
      if (existing.is_active !== true) {
        return {
          changed: false,
          membership_id: existing.id,
          previously_active: false,
        };
      }
      await tx.userTenantMembership.update({
        where: { id: existing.id },
        data: { is_active: false, deactivated_at: new Date() },
      });
      return {
        changed: true,
        membership_id: existing.id,
        previously_active: true,
      };
    });
  }

  // Settings S3a — re-enable a tenant membership. Called as the
  // COMPENSATION step when the Cognito leg of the disable saga fails
  // after the identity flip committed; restores is_active=true and
  // clears deactivated_at so the prior state is recovered cleanly.
  // Also idempotent. Returns the membership_id (or null when missing).
  async reEnableMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<{ membership_id: string } | null> {
    const existing = await this.prisma.userTenantMembership.findUnique({
      where: {
        user_id_tenant_id: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      },
      select: { id: true },
    });
    if (existing === null) return null;
    await this.prisma.userTenantMembership.update({
      where: { id: existing.id },
      data: { is_active: true, deactivated_at: null },
    });
    return { membership_id: existing.id };
  }

  // AUTHZ-2: same-tenant role replacement (Lead ruling 8 case 2). The
  // membership row is preserved; the role-junction rows are diffed.
  async replaceMembershipRoles(args: {
    membership_id: string;
    role_ids: readonly string[];
  }): Promise<{ added_role_ids: string[]; removed_role_ids: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.userTenantMembershipRole.findMany({
        where: { membership_id: args.membership_id },
        select: { role_id: true },
      });
      const have = new Set(existing.map((r) => r.role_id));
      const want = new Set(args.role_ids);
      const added_role_ids = [...want].filter((id) => !have.has(id));
      const removed_role_ids = [...have].filter((id) => !want.has(id));

      if (removed_role_ids.length > 0) {
        await tx.userTenantMembershipRole.deleteMany({
          where: {
            membership_id: args.membership_id,
            role_id: { in: removed_role_ids },
          },
        });
      }
      if (added_role_ids.length > 0) {
        await tx.userTenantMembershipRole.createMany({
          data: added_role_ids.map((role_id) => ({
            id: uuidv7(),
            membership_id: args.membership_id,
            role_id,
          })),
        });
      }
      return { added_role_ids, removed_role_ids };
    });
  }
}

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  deactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    deactivated_at: row.deactivated_at !== null ? row.deactivated_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

type ExternalIdentityRow = {
  id: string;
  provider: string;
  provider_subject: string;
  user_id: string;
  email_snapshot: string | null;
  created_at: Date;
  updated_at: Date;
};

function toExternalIdentityDto(row: ExternalIdentityRow): ExternalIdentityDto {
  return {
    id: row.id,
    provider: row.provider,
    provider_subject: row.provider_subject,
    user_id: row.user_id,
    email_snapshot: row.email_snapshot,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

type MembershipRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  site_id: string | null;
  is_active: boolean;
  invite_status: string;
  joined_at: Date;
  deactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type InvitationRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  membership_id: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toInvitationDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    membership_id: row.membership_id,
    expires_at: row.expires_at.toISOString(),
    accepted_at: row.accepted_at !== null ? row.accepted_at.toISOString() : null,
    revoked_at: row.revoked_at !== null ? row.revoked_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toMembershipDto(row: MembershipRow): MembershipDto {
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    is_active: row.is_active,
    invite_status: row.invite_status,
    joined_at: row.joined_at.toISOString(),
    deactivated_at:
      row.deactivated_at !== null ? row.deactivated_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Settings S5-BE1 — the tenant-user read shape (list row + detail). The
// S5b admin view's contract. Surfaces:
//   - user_id / email / display_name (User identity)
//   - is_active / deactivated_at (MEMBERSHIP-level — UserTenantMembership.
//     is_active + deactivated_at; the columns the S3a soft-disable saga
//     writes. NOT User.is_active which is the global flag.)
//   - site_id (PR-A1a Ruling 4, nullable)
//   - role_keys (sorted asc; only active roles — matches
//     findRoleKeysForMembership)
export interface TenantUserView {
  user_id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  // Invite-S3 (§1 keystone) — the membership's 3-state lifecycle value
  // (INVITED | ACCEPTED | ACTIVE; the S4 FAILED value lands later). The FE
  // layers this with is_active to derive the 5-state displayed status
  // (deriveDisplayedStatus). Without it the roster renders a freshly-invited
  // user as "Active".
  invite_status: string;
  deactivated_at: string | null;
  site_id: string | null;
  role_keys: string[];
}

// §5 Auth-Hardening D4 — the minimal assignable-roster row. DELIBERATELY a
// strict subset of TenantUserView (user_id + display_name ONLY) so that no
// admin field — email, status, roles, site, audit — can leak through an
// assignment picker. A distinct type, not an alias, makes the least-data
// boundary explicit and compiler-enforced.
export interface AssignableUserView {
  user_id: string;
  display_name: string | null;
}

// §5 Auth-Hardening D4b — the name-resolver row. Same minimal shape as
// AssignableUserView (user_id + display_name) but a DISTINCT type: the two
// serve different jobs (assignable = active-only picker; directory = all-users
// name resolution incl. inactive) and may diverge, so they stay separable.
export interface DirectoryUserView {
  user_id: string;
  display_name: string | null;
}

// Aramo-Identity-Me-Endpoint — the raw context behind GET /v1/me, resolved
// for the CALLER's own membership in ONE query. Deliberately a self-read
// projection (the caller's identity, their roles in this tenant, and the
// tenant's org label) — no other user's data is reachable through it (the
// query keys on the composite (user_id, tenant_id)). Role rows carry BOTH
// key and description so the service can resolve the human display name
// (displayFromDescription) without a second round-trip; the presentation
// mapping (key/description → display) lives in the service, not the repo.
export interface MeContextRow {
  email: string;
  display_name: string | null;
  roles: { key: string; description: string | null }[];
  tenant_name: string;
  tenant_display_name: string | null;
}

type TenantUserRow = {
  user_id: string;
  site_id: string | null;
  is_active: boolean;
  invite_status: string;
  deactivated_at: Date | null;
  user: { email: string; display_name: string | null };
  role_assignments: { role: { key: string } }[];
};

function toTenantUserView(row: TenantUserRow): TenantUserView {
  return {
    user_id: row.user_id,
    email: row.user.email,
    display_name: row.user.display_name,
    is_active: row.is_active,
    invite_status: row.invite_status,
    deactivated_at:
      row.deactivated_at !== null ? row.deactivated_at.toISOString() : null,
    site_id: row.site_id,
    role_keys: row.role_assignments.map((ra) => ra.role.key).sort(),
  };
}
