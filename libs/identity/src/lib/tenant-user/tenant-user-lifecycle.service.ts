import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { IdentityService } from '../identity.service.js';
import type { UserDto } from '../dto/user.dto.js';

import { RoleBundleValidator } from './role-bundle-validator.js';
import {
  TENANT_COGNITO_PORT,
  type TenantCognitoPort,
} from './tenant-cognito.port.js';

// Settings S3a — TenantUserLifecycleService.
//
// The cross-store saga orchestrator for tenant-admin user lifecycle:
//   - invite (2-leg: Cognito-tenant-pool → identity; NO entitlement leg,
//     because capabilities are tenant-level and a per-user invite never
//     mutates the tenant's capability grant).
//   - disable (identity-first → Cognito-tenant-pool, with re-enable
//     compensation on Cognito failure).
//
// The DESIGN MIRRORS apps/platform-admin's PlatformInvitationService
// (the AUTHZ-2 precedent) but applies in the tenant tier and on a
// different invariant set:
//   - tenant_id comes from the caller's AuthContext (the controller
//     never accepts a body-supplied tenant_id — per-tenant isolation).
//   - the invite's D5 union-non-invertibility check fires here BEFORE
//     the Cognito leg (so a multi-role invite with an invertible union
//     is rejected without any external side effect).
//   - the disable's identity-first order is deliberate: our access
//     decision (EntitlementGuard + session pipeline) gates on
//     membership.is_active, so flipping the membership first means
//     access is denied the moment the identity tx commits; the inverse
//     order would open a "Cognito disabled / membership active" split-
//     state window. On a Cognito failure post-flip, the identity flip
//     is rolled back (reEnableMembership) so the prior consistent
//     state is restored.
//
// The saga does NOT auto-reassign work owned by the disabled user
// (UserClientAssignment / D4a edges stay intact). Reassignment is a
// separate operational action via the live D4a endpoints — the disable
// surface is the user-state mutation only.

export interface InviteResult {
  user: UserDto;
  membership_id: string;
  cognito_sub: string;
}

export interface DisableResult {
  membership_id: string;
  changed: boolean;
  already_disabled: boolean;
}

@Injectable()
export class TenantUserLifecycleService {
  private readonly logger = new Logger(TenantUserLifecycleService.name);

  constructor(
    private readonly identitySvc: IdentityService,
    private readonly roleBundle: RoleBundleValidator,
    @Inject(TENANT_COGNITO_PORT) private readonly cognito: TenantCognitoPort,
  ) {}

  // INVITE — 2-leg saga.
  //   step 0: validate role_keys is non-empty + union-non-invertible.
  //   step 1: Cognito AdminCreateUser (tenant pool) → returns sub.
  //   step 2: identity tx (User + ExternalIdentity + Membership +
  //           MembershipRole[]) via createUserFromInvitation. On failure,
  //           Cognito-rollback via adminDeleteUser (idempotent).
  // The audit events (identity.user.created / external_identity.linked /
  // membership.created / invitation.created) are emitted from inside
  // createUserFromInvitation — no additional event types for invite.
  async inviteTenantUser(args: {
    tenant_id: string;
    email: string;
    display_name: string | null;
    role_keys: readonly string[];
    actor_user_id: string;
    request_id: string;
  }): Promise<InviteResult> {
    // Step 0a — role_keys must be non-empty (an invite without a role would
    // produce a Membership with zero role assignments, leaving the user with
    // no scopes; reject up-front rather than create an inert membership).
    if (args.role_keys.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'invitation requires at least one role_key',
        400,
        {
          requestId: args.request_id,
          details: { reason: 'empty_role_keys' },
        },
      );
    }

    // Step 0b — resolve role keys to ids. resolveRoleIdsByKeys throws
    // VALIDATION_ERROR on unknown keys (existing behavior).
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys(
      args.role_keys,
    );

    // Step 0c — D5 union-non-invertibility (no-op on 0/1 roles). Runs
    // BEFORE the Cognito side effect so a bad bundle never touches the
    // pool.
    await this.roleBundle.assertUnionNonInvertible({
      role_keys: args.role_keys,
      request_id: args.request_id,
    });

    // Step 1 — Cognito-first.
    let cognito_sub: string;
    try {
      const out = await this.cognito.adminCreateUser({
        email: args.email,
        display_name: args.display_name,
      });
      cognito_sub = out.cognito_sub;
    } catch (err) {
      this.logger.warn(
        `tenant invite — cognito admin create user failed: ${(err as Error).message}`,
      );
      throw new AramoError(
        'COGNITO_PROVISION_FAILED',
        'Cognito AdminCreateUser failed',
        502,
        {
          requestId: args.request_id,
          details: {
            email: args.email,
            pool: 'tenant',
            error_message: (err as Error).message,
          },
        },
      );
    }

    // Step 2 — identity tx; compensate Cognito on failure.
    try {
      const created = await this.identitySvc.createUserFromInvitation({
        email: args.email,
        display_name: args.display_name,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id: args.tenant_id,
        role_ids,
        actor_user_id: args.actor_user_id,
      });
      return {
        user: created.user,
        membership_id: created.membership_id,
        cognito_sub,
      };
    } catch (err) {
      await this.cognito
        .adminDeleteUser({ email: args.email })
        .catch((compErr: unknown) => {
          this.logger.warn(
            `tenant invite — cognito rollback failed: ${(compErr as Error).message}`,
          );
        });
      throw err;
    }
  }

  // DISABLE — identity-first saga.
  //   step 1: identity flip (UserTenantMembership.is_active = false +
  //           deactivated_at). Returns prior state.
  //   step 2: Cognito AdminDisableUser (tenant pool). On failure,
  //           reEnableMembership compensation (restore is_active=true,
  //           clear deactivated_at) → surface COGNITO error.
  // Idempotent: a re-disable of an already-disabled membership skips
  // both Cognito and audit (no spurious side effects, no spurious
  // events).
  //
  // No-auto-reassign boundary preserved: this method only flips the
  // membership state. UserClientAssignment rows + ManagementEdge rows
  // are not touched.
  async disableTenantUser(args: {
    tenant_id: string;
    user_id: string;
    actor_user_id: string;
    reason: string | null;
    request_id: string;
  }): Promise<DisableResult> {
    // Look up the User row to derive the Cognito Username (email — Aramo's
    // Cognito convention, see CognitoAdminService.adminCreateUser). A hard-
    // deleted user → 404. Then check the membership; the deeper check
    // (membership exists for the (user_id, tenant_id) pair) lives inside
    // disableMembership.
    const user = await this.identitySvc.findUserById(args.user_id);
    if (user === null) {
      throw new AramoError(
        'NOT_FOUND',
        'user not found',
        404,
        {
          requestId: args.request_id,
          details: { user_id: args.user_id },
        },
      );
    }

    // Step 1 — identity flip.
    const result = await this.identitySvc.disableMembership({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });

    if (result === null) {
      throw new AramoError(
        'NOT_FOUND',
        'membership not found for user in this tenant',
        404,
        {
          requestId: args.request_id,
          details: { user_id: args.user_id, tenant_id: args.tenant_id },
        },
      );
    }

    if (result.changed === false) {
      // Idempotent re-disable. Skip Cognito (already disabled) and
      // skip the audit event (no state transition to record).
      return {
        membership_id: result.membership_id,
        changed: false,
        already_disabled: true,
      };
    }

    // Step 2 — Cognito disable. Compensate on failure (the load-bearing
    // re-enable; restores the prior state when the cross-store leg
    // breaks).
    try {
      await this.cognito.adminDisableUser({ email: user.email });
    } catch (err) {
      await this.identitySvc
        .reEnableMembership({
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        })
        .catch((compErr: unknown) => {
          this.logger.error(
            `tenant disable — compensation re-enable FAILED: ${(compErr as Error).message}. ` +
              `Membership is_active=false but Cognito is still enabled. Manual reconciliation required.`,
          );
        });
      throw new AramoError(
        'COGNITO_PROVISION_FAILED',
        'Cognito AdminDisableUser failed; membership re-enabled',
        502,
        {
          requestId: args.request_id,
          details: {
            user_id: args.user_id,
            email: user.email,
            pool: 'tenant',
            error_message: (err as Error).message,
            compensation: 're_enabled',
          },
        },
      );
    }

    return {
      membership_id: result.membership_id,
      changed: true,
      already_disabled: false,
    };
  }
}
