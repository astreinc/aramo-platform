import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { IdentityService } from '../identity.service.js';
import type { UserDto } from '../dto/user.dto.js';

import {
  TENANT_COGNITO_PORT,
  type TenantCognitoPort,
} from './tenant-cognito.port.js';
import {
  AUDIT_FINANCIALS_GATE,
  type AuditFinancialsGate,
} from './audit-financials-gate.port.js';

// Settings S4 — the narrow role-key whose grant is policy-gated by the
// tenant's `audit.financials_enabled` KNOWN_SETTING. Exported as a const
// (not a string-literal repeated at the call site) so the load-bearing
// match is single-source-of-truth between the precondition and the
// proof-side tests.
const AUDITOR_WITH_FINANCIALS_ROLE_KEY = 'auditor_with_financials';

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

// Settings S3b — role-assign result. The reconcile can yield BOTH adds AND
// removes in a single PATCH; the controller emits two audit events when both
// deltas are non-empty (and zero when neither is — the empty-delta-no-audit
// precedent). before / after carry role KEYS (not ids) so the audit row is
// human-readable; the delta lists are derived from the key sets.
export interface AssignRolesResult {
  membership_id: string;
  before_role_keys: string[];
  after_role_keys: string[];
  added_role_keys: string[];
  removed_role_keys: string[];
}

@Injectable()
export class TenantUserLifecycleService {
  private readonly logger = new Logger(TenantUserLifecycleService.name);

  // D-AUTHZ-PLATFORM-INVITE-1 (Gate-6, in-service ruling): RoleBundleValidator
  // is no longer a dependency here — the D5 union-non-invertibility check
  // moved INTO IdentityService's three membership-role-write methods, so
  // every caller (tenant, platform, future) is covered safe-by-construction.
  // The validator remains a provider in IdentityModule (registered for
  // IdentityService injection); other consumers of libs/identity can still
  // import the class directly if they need it.
  constructor(
    private readonly identitySvc: IdentityService,
    @Inject(TENANT_COGNITO_PORT) private readonly cognito: TenantCognitoPort,
    @Inject(AUDIT_FINANCIALS_GATE)
    private readonly auditFinancialsGate: AuditFinancialsGate,
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

    // D-AUTHZ-PLATFORM-INVITE-1 (Gate-6, in-service ruling): the D5 union-
    // non-invertibility check that historically lived HERE (BEFORE the
    // Cognito leg) has been moved INTO IdentityService.createUserFromInvitation
    // (libs/identity/.../identity.service.ts) so every caller is covered
    // safe-by-construction. The validator now fires AFTER the Cognito
    // leg but BEFORE any identity-tx persist or audit emission — the
    // Cognito-rollback-on-identity-failure path catches the rejection
    // and compensates. The single-source-of-enforcement property
    // matters more than the early-rejection optimization for tenant-
    // tier invites (the Cognito-side-effect cost is per-invite, not
    // per-validation; and the platform-tier miss that motivated this
    // ruling proved the prior caller-side contract was fragile).

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

    // Step 2 — identity tx; compensate Cognito on failure. The D5 union-
    // non-invertibility check fires INSIDE createUserFromInvitation
    // (D-AUTHZ-PLATFORM-INVITE-1 in-service ruling) — a VALIDATION_ERROR
    // here triggers the Cognito rollback in the catch block below, so
    // an invertible bundle never persists in either store.
    try {
      const created = await this.identitySvc.createUserFromInvitation({
        email: args.email,
        display_name: args.display_name,
        provider: 'cognito',
        provider_subject: cognito_sub,
        tenant_id: args.tenant_id,
        role_keys: args.role_keys,
        role_ids,
        actor_user_id: args.actor_user_id,
        request_id: args.request_id,
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

  // ROLE-ASSIGN (S3b) — single-store; no Cognito; no cross-store saga.
  //
  // Flow (the S3 Gate-5 design, confirmed at S3b Gate-5):
  //   step 0: resolve role_keys -> role_ids (resolveRoleIdsByKeys throws
  //           VALIDATION_ERROR on unknown).
  //   step 1: THE D5 INTEGRITY GATE (load-bearing) — RoleBundleValidator
  //           asserts the UNION of the requested role-set's scopes is
  //           non-invertible (the merged validator; field-masking owns
  //           the boundary). Fires WRITE-TIME, BEFORE the reconcile —
  //           an invertible union can NEVER persist.
  //   step 2: find the membership (user_id + tenant_id from the caller's
  //           session) — 404 if missing (per-tenant isolation).
  //   step 3: snapshot before-state (role KEYS for the audit payload).
  //   step 4: reconcile via the merged replaceMembershipRoles (atomic
  //           createMany/deleteMany on UserTenantMembershipRole).
  //   step 5: compute the key-set delta (added / removed).
  //
  // The controller emits role_assigned / role_removed events from the
  // delta (per the S2 app-layer two-call seam); an empty delta (both
  // sides empty) suppresses BOTH events (the S2 no-op-no-audit
  // precedent).
  //
  // Step 1 is intentionally BEFORE step 2's membership lookup so a bad
  // role-set rejects without leaking membership existence (a tenant_admin
  // who proposes an invertible union gets the same 400 whether or not
  // the user has a membership in the tenant). The membership-not-found
  // branch is the per-tenant isolation 404 (same as disable).
  async assignTenantUserRoles(args: {
    tenant_id: string;
    user_id: string;
    role_keys: readonly string[];
    actor_user_id: string;
    request_id: string;
  }): Promise<AssignRolesResult> {
    if (args.role_keys.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'role-assign requires at least one role_key',
        400,
        {
          requestId: args.request_id,
          details: { reason: 'empty_role_keys' },
        },
      );
    }

    // Step 0 — resolve. Unknown key surfaces as VALIDATION_ERROR
    // (existing behavior at resolveRoleIdsByKeys).
    const role_ids = await this.identitySvc.resolveRoleIdsByKeys(
      args.role_keys,
    );

    // Settings S4 — THE NARROW GATE PRECONDITION.
    //
    // Policy gate keyed to the SINGLE role-key 'auditor_with_financials':
    // the tenant's `audit.financials_enabled` KNOWN_SETTING must be true
    // BEFORE the grant persists. The check fires ONLY when the requested
    // role-set contains this one key — every other role-set flows
    // through unchanged (S3b's general behavior is preserved; the GATE
    // is NOT a global precondition).
    //
    // Order: AFTER resolve (so an unknown role-key fails fast with the
    // existing error shape), BEFORE the D5 union check + the membership
    // lookup. The precondition is policy, not integrity — both are
    // checked write-time, before any membership-row mutation. A
    // rejected GATE NEVER reaches the reconcile.
    //
    // Rejection: VALIDATION_ERROR (400) with
    // details.reason='financials_audit_not_enabled' — a SEPARATE reason
    // from the D5 boundary's 'invertible_role_union' so callers can
    // distinguish a policy-precondition failure from an integrity
    // failure. Details carry the role_key for self-correction.
    if (args.role_keys.includes(AUDITOR_WITH_FINANCIALS_ROLE_KEY)) {
      const enabled = await this.auditFinancialsGate.isFinancialsAuditEnabled(
        args.tenant_id,
      );
      if (!enabled) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'audit.financials_enabled must be true to grant auditor_with_financials',
          400,
          {
            requestId: args.request_id,
            details: {
              reason: 'financials_audit_not_enabled',
              role_key: AUDITOR_WITH_FINANCIALS_ROLE_KEY,
            },
          },
        );
      }
    }

    // D-AUTHZ-PLATFORM-INVITE-1 (Gate-6, in-service ruling): the D5 union-
    // non-invertibility check that historically lived HERE (between the S4
    // gate and the membership lookup) has been moved INTO
    // IdentityService.replaceMembershipRoles. The S4 gate stays here
    // (policy precondition, not integrity); the D5 check fires inside the
    // reconcile primitive in step 4 below. Re-ordering note: this changes
    // the rejection ordering for the (invertible-union + missing-membership)
    // case — pre-fix the D5 400 surfaced; post-fix the membership lookup
    // runs first and a missing membership returns 404 before the D5 check
    // is reached. The information-disclosure tradeoff (was: same 400 for
    // missing-or-present; now: 404 if missing, 400 if present-and-
    // invertible) is acceptable per the in-service ruling — the
    // membership-existence info is already exposed by the disable surface,
    // and the single-source-of-enforcement guarantee outweighs the
    // ordering nuance.

    // Step 2 — locate the membership in THIS tenant. 404 if absent;
    // per-tenant isolation.
    const membership = await this.identitySvc.findMembership({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });
    if (membership === null) {
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

    // Step 3 — snapshot before-state (KEYS for the audit payload).
    const before_role_keys =
      await this.identitySvc.findRoleKeysForMembership(membership.id);

    // Step 4 — reconcile. The merged primitive is atomic
    // (createMany/deleteMany inside $transaction). The D5 union-non-
    // invertibility check fires INSIDE replaceMembershipRoles
    // (D-AUTHZ-PLATFORM-INVITE-1 in-service) — an invertible union
    // throws VALIDATION_ERROR here and never reaches the $transaction.
    await this.identitySvc.replaceMembershipRoles({
      membership_id: membership.id,
      role_keys: args.role_keys,
      role_ids,
      request_id: args.request_id,
    });

    // Step 5 — compute key-set delta. We compute from keys rather than
    // ids because the audit payload carries keys, and a key-based diff
    // is the human-readable change-log primary identity used downstream.
    const beforeSet = new Set(before_role_keys);
    const afterSet = new Set(args.role_keys);
    const after_role_keys = [...afterSet].sort();
    const added_role_keys = [...afterSet]
      .filter((k) => !beforeSet.has(k))
      .sort();
    const removed_role_keys = [...beforeSet]
      .filter((k) => !afterSet.has(k))
      .sort();

    return {
      membership_id: membership.id,
      before_role_keys: [...before_role_keys].sort(),
      after_role_keys,
      added_role_keys,
      removed_role_keys,
    };
  }
}
