import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { ExternalIdentityDto } from './dto/external-identity.dto.js';
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
  joined_at: Date;
  deactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toMembershipDto(row: MembershipRow): MembershipDto {
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    is_active: row.is_active,
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

type TenantUserRow = {
  user_id: string;
  site_id: string | null;
  is_active: boolean;
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
    deactivated_at:
      row.deactivated_at !== null ? row.deactivated_at.toISOString() : null,
    site_id: row.site_id,
    role_keys: row.role_assignments.map((ra) => ra.role.key).sort(),
  };
}
