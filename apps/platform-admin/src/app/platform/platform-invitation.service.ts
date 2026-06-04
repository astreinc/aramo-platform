import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import {
  EntitlementRepository,
  type Capability,
  isCapability,
} from '@aramo/entitlement';
import {
  IdentityService,
  TenantService,
} from '@aramo/identity';

import { CognitoAdminService } from './cognito/cognito-admin.service.js';

// PlatformInvitationService — orchestrates the cross-schema saga (Lead
// ruling 7):
//   1. Cognito (TENANT or PLATFORM pool) — AdminCreateUser (Pattern A,
//      Lead ruling 1; Cognito owns credential + temp-password email).
//   2. Identity tx (libs/identity) — Tenant (provisioning case only) +
//      User + ExternalIdentity + Membership + MembershipRole, atomic.
//   3. Entitlement tx (libs/entitlement) — grant {core, ats, portal}
//      rows for the new tenant (provisioning case only).
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
// Idempotency / re-invite (Lead ruling 8 — the 4 cases):
//   - existing User + existing membership in this tenant => 409
//     INVITATION_ALREADY_EXISTS (no Cognito recreate).
//   - existing User + no membership in this tenant => add membership,
//     reuse Cognito + User + ExternalIdentity.
//   - same-tenant role replacement => reconcile UserTenantMembershipRole
//     (not yet wired through this service in this PR -- handled at the
//     service layer if a controller later exposes PATCH role_keys).
//   - drift (Cognito has user, identity does not) => recover by writing
//     identity rows against the existing Cognito sub.

const DEFAULT_CAPABILITIES: readonly Capability[] = ['core', 'ats', 'portal'];

export interface ProvisionResult {
  tenant_id: string;
  tenant_name: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: Capability[];
}

export interface InviteResult {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  status: 'invitation_sent' | 'roles_updated' | 'membership_added';
}

@Injectable()
export class PlatformInvitationService {
  private readonly logger = new Logger(PlatformInvitationService.name);

  constructor(
    private readonly cognito: CognitoAdminService,
    private readonly tenantSvc: TenantService,
    private readonly identitySvc: IdentityService,
    private readonly entitlementRepo: EntitlementRepository,
  ) {}

  async provisionTenantAndInviteOwner(args: {
    name: string;
    owner_email: string;
    owner_display_name?: string | null;
    capabilities?: readonly string[];
    actor_user_id: string;
  }): Promise<ProvisionResult> {
    // 0. Validate capability set (default = core,ats,portal).
    const desired: readonly Capability[] =
      args.capabilities === undefined || args.capabilities.length === 0
        ? DEFAULT_CAPABILITIES
        : args.capabilities.filter(isCapability);

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

    // 0b. Resolve role IDs (the Tenant-Owner-first invite hard-fixes
    // the role to 'tenant_owner').
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys([
      'tenant_owner',
    ]);

    // 1. Cognito (TENANT pool) — AdminCreateUser. Pattern A: Cognito
    // owns the credential + invitation email; Aramo never holds a
    // password.
    let cognito_sub: string;
    try {
      const out = await this.cognito.adminCreateUser({
        pool: 'tenant',
        email: args.owner_email,
        display_name: args.owner_display_name ?? null,
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
        actor_user_id: args.actor_user_id,
      });
      tenant_id = tenant.id;
      const created = await this.identitySvc.createUserFromInvitation({
        email: args.owner_email,
        display_name: args.owner_display_name ?? null,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id,
        role_ids,
        actor_user_id: args.actor_user_id,
      });
      owner_user_id = created.user.id;
      membership_id = created.membership_id;
    } catch (err) {
      await this.compensateCognito(args.owner_email, 'tenant').catch(
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

    return {
      tenant_id,
      tenant_name: args.name,
      owner_user_id,
      owner_email: args.owner_email,
      membership_id,
      capabilities: [...desired],
    };
  }

  async inviteUserIntoTenant(args: {
    tenant_id: string;
    email: string;
    role_keys: readonly string[];
    display_name?: string | null;
    actor_user_id: string;
    pool: 'tenant' | 'platform';
  }): Promise<InviteResult> {
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys(args.role_keys);

    // Idempotency: AdminGetUser is the existence probe at the Cognito
    // boundary (Lead ruling 8).
    const cognitoExisting = await this.cognito.adminGetUser({
      pool: args.pool,
      email: args.email,
    });
    const identityExisting = await this.identitySvc.findUserByEmail(args.email);

    if (cognitoExisting !== null && identityExisting !== null) {
      // Cases 1 (409) + 2 (200 reconcile) + 3 (201 new membership) — the
      // user already exists in both stores. Branch on whether they hold a
      // membership in this tenant.
      const membership = await this.identitySvc.findMembership({
        user_id: identityExisting.id,
        tenant_id: args.tenant_id,
      });
      if (membership !== null) {
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
                email: args.email,
                tenant_id: args.tenant_id,
                existing_membership_id: membership.id,
              },
            },
          );
        }
        // Same-tenant role replacement (Lead ruling 8 case 2).
        await this.identitySvc.replaceMembershipRoles({
          membership_id: membership.id,
          role_ids,
        });
        return {
          tenant_id: args.tenant_id,
          user_id: identityExisting.id,
          membership_id: membership.id,
          role_keys: [...args.role_keys],
          status: 'roles_updated',
        };
      }
      // New-tenant for existing user (Lead ruling 8 case 3).
      const added = await this.identitySvc.addMembershipForExistingUser({
        user_id: identityExisting.id,
        tenant_id: args.tenant_id,
        role_ids,
        actor_user_id: args.actor_user_id,
      });
      return {
        tenant_id: args.tenant_id,
        user_id: identityExisting.id,
        membership_id: added.membership_id,
        role_keys: [...args.role_keys],
        status: 'membership_added',
      };
    }

    if (cognitoExisting !== null && identityExisting === null) {
      // Drift recovery (Lead ruling 8 case 4). Reuse the existing
      // Cognito sub; write identity rows mirror-style.
      const created = await this.identitySvc.createUserFromInvitation({
        email: args.email,
        display_name: args.display_name ?? null,
        provider: 'cognito',
        provider_subject: cognitoExisting.cognito_sub,
        tenant_id: args.tenant_id,
        role_ids,
        actor_user_id: args.actor_user_id,
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
        email: args.email,
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
            email: args.email,
            pool: args.pool,
            error_message: (err as Error).message,
          },
        },
      );
    }

    let created;
    try {
      created = await this.identitySvc.createUserFromInvitation({
        email: args.email,
        display_name: args.display_name ?? null,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id: args.tenant_id,
        role_ids,
        actor_user_id: args.actor_user_id,
      });
    } catch (err) {
      await this.compensateCognito(args.email, args.pool).catch(
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

  async invitePlatformAdmin(args: {
    email: string;
    display_name?: string | null;
    actor_user_id: string;
  }): Promise<InviteResult> {
    return this.inviteUserIntoTenant({
      tenant_id: PLATFORM_TENANT_SENTINEL_ID,
      email: args.email,
      role_keys: ['super_admin'],
      display_name: args.display_name ?? null,
      actor_user_id: args.actor_user_id,
      pool: 'platform',
    });
  }

  private async compensateCognito(
    email: string,
    pool: 'tenant' | 'platform',
  ): Promise<void> {
    await this.cognito.adminDeleteUser({ pool, email });
  }
}
