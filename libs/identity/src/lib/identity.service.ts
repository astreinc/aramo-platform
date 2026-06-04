import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { MembershipDto } from './dto/membership.dto.js';
import type { UserDto } from './dto/user.dto.js';
import { IdentityRepository } from './identity.repository.js';

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
@Injectable()
export class IdentityService {
  constructor(
    private readonly identityRepo: IdentityRepository,
    private readonly audit: IdentityAuditService,
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

  async findMembership(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<MembershipDto | null> {
    return this.identityRepo.findMembership(args);
  }

  // AUTHZ-2: the FIRST runtime User-write surface. Called only by the
  // platform-tier invitation flow (apps/platform-admin) after Cognito
  // AdminCreateUser has returned the Cognito sub. The actor_id is the
  // platform-admin caller (the super_admin user); the tenant_id on the
  // emitted audit events is the invited-into tenant (the new Tenant
  // Owner's tenant in the first-act case; an existing tenant in a
  // Settings-driven invite once that surface lands).
  async createUserFromInvitation(args: {
    email: string;
    display_name: string | null;
    provider: string;
    provider_subject: string;
    tenant_id: string;
    role_ids: readonly string[];
    actor_user_id: string;
  }): Promise<{ user: UserDto; membership_id: string }> {
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
  async addMembershipForExistingUser(args: {
    user_id: string;
    tenant_id: string;
    role_ids: readonly string[];
    actor_user_id: string;
  }): Promise<{ membership_id: string }> {
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
          requestId: 'invitation',
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
  async replaceMembershipRoles(args: {
    membership_id: string;
    role_ids: readonly string[];
  }): Promise<{ added_role_ids: string[]; removed_role_ids: string[] }> {
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
}
