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

  async findUserByEmail(email: string): Promise<UserDto | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
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

  async findRoleIdsForMembership(membership_id: string): Promise<string[]> {
    const rows = await this.prisma.userTenantMembershipRole.findMany({
      where: { membership_id },
      select: { role_id: true },
    });
    return rows.map((r) => r.role_id);
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
