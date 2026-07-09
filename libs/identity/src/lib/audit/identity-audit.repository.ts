import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

// Closed sets per directive §6. Unknown value at write time → halt-and-surface
// (AramoError INTERNAL_ERROR). Used by both seed and integration tests.
export const ACTOR_TYPES = ['system', 'service_account', 'user', 'provider'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EVENT_TYPES = [
  'identity.user.created',
  'identity.tenant.created',
  'identity.membership.created',
  'identity.role.created',
  'identity.scope.created',
  'identity.service_account.created',
  'identity.external_identity.linked',
  // PR-8.0a-Reground §6 amendment: 4 session-lifecycle event_types added.
  // All tenant-scoped; emitted by auth-service /callback, /refresh, /logout.
  'identity.session.issued',
  'identity.session.refreshed',
  'identity.session.revoked',
  'identity.session.reuse_detected',
  // AUTHZ-2 — invitation lifecycle. Both tenant-scoped (carry the
  // invited-into tenant_id). `created` is emitted when provisionTenant
  // /invite mirrors the new (User + ExternalIdentity + Membership +
  // MembershipRole) after AdminCreateUser returns the Cognito sub.
  // `accepted` is emitted by apps/auth-service on the invitee's first
  // successful /callback (the existing resolve seam now finds them).
  'identity.invitation.created',
  'identity.invitation.accepted',
  // AUTHZ-D4a — 9 team-model substrate event_types (all tenant-scoped;
  // emitted by the assign-to-client / set-management-edge / manage-pod
  // mechanisms). D4a is WRITE-SIDE only — these events record substrate
  // writes; D4b's predicate (read-side) emits no events.
  'identity.management_edge.set',
  'identity.management_edge.cleared',
  'identity.team.created',
  'identity.team.membership.added',
  'identity.team.membership.removed',
  'identity.team.client_ownership.added',
  'identity.team.client_ownership.removed',
  'identity.user_client_assignment.created',
  'identity.user_client_assignment.removed',
  // Settings S2 — tenant-config write event. Emitted by the app-layer
  // two-call seam in apps/api's TenantSettingsController (the controller
  // is the seam; libs/settings stays a LEAF — NO @aramo/identity import
  // there). Tenant-scoped (the writing tenant). subject_id is the
  // tenant_id (the @db.Uuid column cannot carry the string setting key;
  // the key lives in the payload). Payload shape:
  //   { key: KnownSettingKey, value: SettingValueOf<K>,
  //     previous_value: SettingValueOf<K> | null }
  // First-set (no prior row) sends `previous_value: null`. The event is
  // BEST-EFFORT — an audit failure logs at warn level but never blocks
  // the setting write (the program-wide identity-audit posture).
  'identity.tenant_setting.updated',
  // Settings S3a — tenant-user lifecycle (DISABLE leg). Emitted by
  // TenantUserManagementController.disable after the identity-first
  // soft-disable (UserTenantMembership.is_active=false + deactivated_at)
  // commits AND the Cognito AdminDisableUser leg succeeds (per the
  // saga; a Cognito failure rolls back the membership flip and the
  // event is NOT emitted). Tenant-scoped (the membership's tenant).
  // subject_id is the disabled user_id; payload carries membership_id
  // + reason (optional). The INVITE leg reuses the existing
  // identity.user.created + identity.external_identity.linked +
  // identity.membership.created + identity.invitation.created events
  // emitted by createUserFromInvitation (no new event_type for invite).
  'identity.tenant_user.disabled',
  // Settings S3b — tenant-user role-assign. Emitted by
  // TenantUserManagementController.assignRoles (PATCH /v1/tenant/users/
  // :user_id/roles) AFTER the merged replaceMembershipRoles reconcile
  // commits. TWO events because reconcile can produce both adds AND
  // removes in a single PATCH (the role-set diff); the controller
  // emits each only when its delta is non-empty (the S2 no-op-no-audit
  // precedent — an unchanged role-set emits NEITHER event). Both
  // tenant-scoped (the membership's tenant). subject_id is the
  // affected user_id; payload carries
  //   { membership_id,
  //     added_role_keys / removed_role_keys,  -- per event
  //     before_role_keys, after_role_keys }
  // The D5 union-non-invertibility check (the merged
  // RoleBundleValidator) fires BEFORE the reconcile commits, so an
  // invertible union never reaches the audit path.
  'identity.tenant_user.role_assigned',
  'identity.tenant_user.role_removed',
  // Settings Rebuild D3 — tenant-profile update. Emitted by the
  // TenantProfileController after a PATCH actually changes ≥1 field (no-op-no-
  // audit). Tenant-scoped; subject_id is the tenant_id; payload carries the
  // CHANGED FIELD NAMES only (not values — a profile value like tax_id stays
  // out of the audit detail). The audit READ surface (Directive 2) now reads it.
  'identity.tenant_profile.updated',
  // Settings Rebuild D4 — sites/branches CRUD. Emitted by the SitesController
  // after a create / a PATCH that actually changes ≥1 field / a deactivate
  // that actually flips is_active (no-op-no-audit, the S2/S3a precedent).
  // Tenant-scoped; subject_id is the site_id; payload carries the CHANGED
  // FIELD NAMES (and the site's own name/parent ids), never sensitive values.
  // The audit READ surface (Directive 2) now reads them.
  'identity.site.created',
  'identity.site.updated',
  'identity.site.deactivated',
  // Domain-Enforcement P2b — DNS-TXT ownership verification lifecycle. Emitted
  // by the DomainVerificationController two-call seam. `requested` on a token
  // (re)issue (→ PENDING); `verified` ONLY on the transition to VERIFIED (no-op-
  // no-audit — a re-check that stays PENDING emits nothing). Both tenant-scoped;
  // subject_id is the tenant_id; payload carries the domain (no token — the token
  // is public but irrelevant to the audit trail).
  'identity.domain.verification.requested',
  'identity.domain.verified',
  // Platform-Console Increment-2 PR-1 — tenant lifecycle state machine. All
  // tenant-scoped (carry the tenant_id). `activated` is emitted by the inline
  // activation hook with actor_type='system'; the operator transitions
  // (suspended/reactivated/offboarding_started/closed) with actor_type='user';
  // `lifecycle_transition_rejected` records an illegal transition attempt.
  // Retention events (retention_scheduled/executed) are deferred with the
  // counsel-gated retention policy.
  'tenant.provisioned',
  'tenant.owner_invite.sent',
  'tenant.owner_invite.accepted',
  'tenant.activated',
  'tenant.suspended',
  'tenant.reactivated',
  'tenant.offboarding_started',
  'tenant.closed',
  'tenant.lifecycle_transition_rejected',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// event_type → index-category mapping (directive §6, locked). Each event_type
// targets exactly one index; mapping is exhaustive and disjoint. The seed (and
// any future writer) uses this to decide whether tenant_id is set or null.
export const TENANT_SCOPED_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'identity.tenant.created',
  'identity.membership.created',
  // PR-8.0a-Reground §6 amendment: 4 session-lifecycle event_types are
  // tenant-scoped (carry tenant_id; written to (tenant_id, subject_id, …) index).
  'identity.session.issued',
  'identity.session.refreshed',
  'identity.session.revoked',
  'identity.session.reuse_detected',
  // AUTHZ-2: both invitation events are tenant-scoped (the invited-into
  // tenant).
  'identity.invitation.created',
  'identity.invitation.accepted',
  // AUTHZ-D4a: all 9 team-model events are tenant-scoped (carry the
  // tenant_id the substrate write happened in).
  'identity.management_edge.set',
  'identity.management_edge.cleared',
  'identity.team.created',
  'identity.team.membership.added',
  'identity.team.membership.removed',
  'identity.team.client_ownership.added',
  'identity.team.client_ownership.removed',
  'identity.user_client_assignment.created',
  'identity.user_client_assignment.removed',
  // Settings S2 — tenant-config writes carry the writing-tenant's id.
  'identity.tenant_setting.updated',
  // Settings S3a — tenant-user lifecycle DISABLE is per-tenant (the
  // membership lives in one tenant; a user with memberships in N tenants
  // disables once per tenant). subject_id is the user_id; tenant_id is
  // the membership's tenant.
  'identity.tenant_user.disabled',
  // Settings S3b — tenant-user role-assign is per-tenant (the
  // membership's roles live in one tenant). Same subject_id +
  // tenant_id discipline as disable.
  'identity.tenant_user.role_assigned',
  'identity.tenant_user.role_removed',
  // Settings Rebuild D3 — tenant-profile update carries the writing tenant's id.
  'identity.tenant_profile.updated',
  // Settings Rebuild D4 — sites/branches CRUD all carry the writing tenant's id.
  'identity.site.created',
  'identity.site.updated',
  'identity.site.deactivated',
  // Domain-Enforcement P2b — both verification events carry the writing tenant's id.
  'identity.domain.verification.requested',
  'identity.domain.verified',
  // Platform-Console Increment-2 PR-1 — all tenant-lifecycle events carry the
  // subject tenant's id (tenant-scoped).
  'tenant.provisioned',
  'tenant.owner_invite.sent',
  'tenant.owner_invite.accepted',
  'tenant.activated',
  'tenant.suspended',
  'tenant.reactivated',
  'tenant.offboarding_started',
  'tenant.closed',
  'tenant.lifecycle_transition_rejected',
]);

export interface WriteAuditEventInput {
  tenant_id: string | null;
  actor_id: string | null;
  actor_type: ActorType;
  event_type: EventType;
  subject_id: string;
  event_payload: Record<string, unknown>;
  // Optional explicit id (seed uses fixed IDs for determinism). When absent,
  // a UUID v7 is generated app-side.
  id?: string;
  // Request correlation for halt-and-report errors. When absent (e.g., seed/
  // bootstrap path), a system sentinel is used.
  requestId?: string;
}

const SYSTEM_REQUEST_ID = 'system-internal';

@Injectable()
export class IdentityAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async writeEvent(input: WriteAuditEventInput): Promise<{ id: string }> {
    const requestId = input.requestId ?? SYSTEM_REQUEST_ID;
    assertActorType(input.actor_type, requestId);
    assertEventType(input.event_type, requestId);
    assertMappingObeyed(input.event_type, input.tenant_id, requestId);

    const id = input.id ?? uuidv7();
    await this.prisma.identityAuditEvent.create({
      data: {
        id,
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        actor_type: input.actor_type,
        event_type: input.event_type,
        subject_id: input.subject_id,
        event_payload: input.event_payload as never,
      },
    });
    return { id };
  }

  // Settings Rebuild Directive 2 — the audit READ surface.
  //
  // Tenant-scoped keyset read over IdentityAuditEvent, most-recent-first
  // ((created_at DESC, id DESC) — the composite key on the tenant index).
  // tenant_id is ALWAYS pinned by the caller from the JWT (never the request
  // body/URL) — cross-tenant reads are structurally impossible. Filters
  // (actor / event_type / date-range / subject) compose with AND. Returns
  // `limit + 1` rows so the service can detect a next page without a count.
  async findByTenant(params: FindByTenantParams): Promise<AuditEventRow[]> {
    const { tenant_id, limit, cursor, filters } = params;
    const where: Record<string, unknown> = { tenant_id };
    if (filters?.actor_id !== undefined) where['actor_id'] = filters.actor_id;
    if (filters?.event_type !== undefined) where['event_type'] = filters.event_type;
    if (filters?.subject_id !== undefined) where['subject_id'] = filters.subject_id;
    if (filters?.from !== undefined || filters?.to !== undefined) {
      where['created_at'] = {
        ...(filters?.from !== undefined ? { gte: filters.from } : {}),
        ...(filters?.to !== undefined ? { lte: filters.to } : {}),
      };
    }
    if (cursor !== undefined) {
      // Keyset: strictly "older than" the cursor in (created_at DESC, id DESC).
      where['OR'] = [
        { created_at: { lt: cursor.created_at } },
        {
          AND: [
            { created_at: cursor.created_at },
            { id: { lt: cursor.event_id } },
          ],
        },
      ];
    }
    const rows = await this.prisma.identityAuditEvent.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return rows as AuditEventRow[];
  }
}

export interface FindByTenantParams {
  readonly tenant_id: string;
  readonly limit: number;
  readonly cursor?: { readonly created_at: Date; readonly event_id: string };
  readonly filters?: {
    readonly actor_id?: string;
    readonly event_type?: EventType;
    readonly subject_id?: string;
    readonly from?: Date;
    readonly to?: Date;
  };
}

export interface AuditEventRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly actor_id: string | null;
  readonly actor_type: ActorType;
  readonly event_type: EventType;
  readonly subject_id: string;
  readonly event_payload: Record<string, unknown>;
  readonly created_at: Date;
}

function assertActorType(value: string, requestId: string): asserts value is ActorType {
  if (!(ACTOR_TYPES as readonly string[]).includes(value)) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `IdentityAuditEvent.actor_type outside closed set: ${value}`,
      500,
      { requestId, details: { received_actor_type: value, allowed: [...ACTOR_TYPES] } },
    );
  }
}

function assertEventType(value: string, requestId: string): asserts value is EventType {
  if (!(EVENT_TYPES as readonly string[]).includes(value)) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `IdentityAuditEvent.event_type outside closed set: ${value}`,
      500,
      { requestId, details: { received_event_type: value, allowed: [...EVENT_TYPES] } },
    );
  }
}

// Enforces directive §6 event_type → index-category mapping.
// tenant-scoped events require tenant_id set; global events require tenant_id null.
function assertMappingObeyed(
  event_type: EventType,
  tenant_id: string | null,
  requestId: string,
): void {
  const requiresTenant = TENANT_SCOPED_EVENT_TYPES.has(event_type);
  if (requiresTenant && tenant_id === null) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `event_type ${event_type} is tenant-scoped per directive §6 mapping but tenant_id is null`,
      500,
      { requestId, details: { event_type, expected: 'tenant_id set' } },
    );
  }
  if (!requiresTenant && tenant_id !== null) {
    throw new AramoError(
      'INTERNAL_ERROR',
      `event_type ${event_type} is global per directive §6 mapping but tenant_id was set`,
      500,
      { requestId, details: { event_type, expected: 'tenant_id null' } },
    );
  }
}
