import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { EventType } from './audit/identity-audit.repository.js';
import type { TenantDto } from './dto/tenant.dto.js';
import { TenantRepository, type PlatformTenantListRow } from './tenant.repository.js';
import { deriveAllowedDomainOrThrow } from './util/email-domain.js';
import { deriveSlugOrThrow } from './util/tenant-slug.js';
import {
  isLegalTransition,
  isTenantStatus,
  TENANT_STATUSES,
  type TenantStatus,
} from './util/tenant-lifecycle.js';

// TenantService — at AUTHZ-1, this surface was read-only
// (getTenantsByUser) with the auth-service SessionOrchestrator the only
// consumer of the read path.
//
// AUTHZ-2 (Lead ruling 6): identity owns Tenant, so the create surface
// lives here, app-guarded by `platform:tenant:provision` at the
// apps/platform-admin layer. The cross-schema saga (Cognito ->
// identity-tx -> entitlement-tx) is orchestrated by the platform-admin
// invitation service; this service is the identity-tx for the Tenant
// row + the identity.tenant.created audit. The 13 tenant role catalog
// and the 47 tenant scope catalog are unchanged — provisioning seeds
// only the Tenant row + the entitlement rows (capability presence-as-
// entitled). The Tenant-Owner-first invite is the platform-admin
// service's responsibility (it composes provisionTenant +
// IdentityService.createUserFromInvitation).
@Injectable()
export class TenantService {
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly audit: IdentityAuditService,
  ) {}

  async getTenantsByUser(args: { user_id: string }): Promise<TenantDto[]> {
    return this.tenantRepo.findActiveTenantsForUser(args);
  }

  // Platform-Console Increment-2 PR-1.5 (A1) — the platform-operator estate
  // list. Delegates to the ungated repository read (every tenant, every status).
  // Kept SEPARATE from getTenantsByUser (the session-mint read) so the mint path
  // is never coupled to the operator view. Scope-gated at the controller
  // (platform:tenant:read); no membership filter here by design.
  async listTenantsForPlatform(args: {
    status?: string;
    q?: string;
  }): Promise<PlatformTenantListRow[]> {
    return this.tenantRepo.listAllTenants(args);
  }

  async findByNameCaseInsensitive(name: string): Promise<TenantDto | null> {
    return this.tenantRepo.findByNameCaseInsensitive(name);
  }

  // Subdomain-Identity Directive A — resolve a tenant by its subdomain slug,
  // active only. The single read the public cert-eligibility ask-endpoint needs
  // ("is <slug>.aramo.ai a real active tenant?") and the same lookup Directive
  // B's host→tenant IdP routing will reuse on this column. Returns null for an
  // unknown or disabled slug (the caller maps that to a 404 / not-eligible).
  async findActiveBySlug(slug: string): Promise<TenantDto | null> {
    return this.tenantRepo.findActiveBySlug(slug);
  }

  // Platform-Console Increment-2 PR-1 — single-tenant read for the platform
  // console detail endpoint. Null for an unknown id.
  async getTenantById(id: string): Promise<TenantDto | null> {
    return this.tenantRepo.findById(id);
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — record the owner-invite re-send
  // in the audit ledger. The audit write stays inside libs/identity (the
  // event_type registry + writer live here); the platform-admin resend
  // orchestration calls this after the Cognito re-send succeeds. Tenant-scoped;
  // subject_id is the owner user_id (the invited subject); payload carries the
  // reason (`resend`). Uses the already-registered `tenant.owner_invite.sent`
  // event_type (no new event_type).
  async recordOwnerInviteSent(args: {
    tenant_id: string;
    owner_user_id: string;
    actor_id: string;
    reason: string;
  }): Promise<void> {
    await this.audit.writeEvent({
      event_type: 'tenant.owner_invite.sent',
      actor_type: 'user',
      actor_id: args.actor_id,
      tenant_id: args.tenant_id,
      subject_id: args.owner_user_id,
      payload: { reason: args.reason },
    });
  }

  // Inc-3 PR-3.4 (create-now-invite-later, B3) — has the owner invite EVER been
  // sent for this tenant? Derives the send reason at the resend endpoint:
  // no prior `tenant.owner_invite.sent` → `first_send` (the tenant was
  // provisioned with invite_owner=false and this is the first mail); otherwise
  // → `resend`. History-derived (not a stored column) — no migration.
  async hasOwnerInviteBeenSent(tenant_id: string): Promise<boolean> {
    return this.audit.hasTenantEvent(tenant_id, 'tenant.owner_invite.sent');
  }

  // Inc-3 PR-3.8 (A) — the operator dashboard summary, assembled read-only from
  // existing tenant + audit rows (no new event types, no new columns, no
  // migration). Three sections:
  //   status_counts — tenants per lifecycle status, zero-filled across the full
  //     TENANT_STATUSES set (a status with no tenants still reports 0), with the
  //     platform SENTINEL EXCLUDED (it is infrastructure, not estate; excluded by
  //     its fixed UUID — there is no flag/column for it).
  //   onboarding — PROVISIONED tenants oldest-first (the "who is stuck" list),
  //     capped, each carrying its age anchor (created_at) and the audit-derived
  //     invited-vs-not-yet-invited signal (a `tenant.owner_invite.sent` probe —
  //     the same signal the detail screen derives; PR-3.4).
  //   recent_activity — the most recent tenant.* lifecycle events across ALL
  //     tenants, capped, with tenant names resolved and the reason code lifted
  //     out of the event payload for the FE feed.
  // R10 discipline: this returns counts, ages, statuses, and events — never a
  // numeric rating/health of any tenant.
  async getPlatformDashboard(args?: {
    onboardingLimit?: number;
    activityLimit?: number;
  }): Promise<PlatformDashboardData> {
    const onboardingLimit = args?.onboardingLimit ?? 10;
    const activityLimit = args?.activityLimit ?? 15;

    // status_counts — sentinel-excluded, zero-filled across every status.
    const rawCounts = await this.tenantRepo.countTenantsByStatus(
      PLATFORM_TENANT_SENTINEL_ID,
    );
    const byStatus = new Map(rawCounts.map((c) => [c.status, c.count]));
    const status_counts = TENANT_STATUSES.map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    }));

    // onboarding — PROVISIONED, oldest-first, invited-state derived per row.
    const provisioned = await this.tenantRepo.findOnboardingProvisioned(
      PLATFORM_TENANT_SENTINEL_ID,
      onboardingLimit,
    );
    const onboarding = await Promise.all(
      provisioned.map(async (t) => ({
        tenant_id: t.id,
        name: t.name,
        created_at: t.created_at,
        invited: await this.audit.hasTenantEvent(
          t.id,
          'tenant.owner_invite.sent',
        ),
      })),
    );

    // recent_activity — cross-tenant tenant.* events, names resolved in one read.
    const events = await this.audit.getRecentTenantLifecycleActivity(
      activityLimit,
    );
    const ids = [
      ...new Set(
        events
          .map((e) => e.tenant_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const names = await this.tenantRepo.findNamesByIds(ids);
    const recent_activity = events.map((e) => ({
      event_type: e.event_type,
      tenant_id: e.tenant_id,
      tenant_name: e.tenant_id === null ? null : names.get(e.tenant_id) ?? null,
      actor_type: e.actor_type,
      reason_code: extractReasonCode(e.event_payload),
      created_at: e.created_at.toISOString(),
    }));

    return { status_counts, onboarding, recent_activity };
  }

  // AUTHZ-2: the guarded tenant-provisioning surface. Raises
  // TENANT_ALREADY_EXISTS (409) when the name collides case-
  // insensitively. The caller (platform-admin's PlatformInvitationService)
  // is responsible for sequencing Cognito (AdminCreateUser for the
  // Tenant Owner) BEFORE invoking provisionTenant, then for invoking the
  // entitlement-tx after the identity write completes. Soft-disable on
  // entitlement-tx failure (Lead ruling 7) is performed via
  // deactivateTenant below.
  //
  // Domain-Enforcement P1 (the SERVICE-LAYER invariant — the load-bearing
  // placement choice): the reject-personal check + allowed_domain derivation
  // live HERE, not in the platform-admin controller. Every tenant-creation
  // path calls provisionTenant (today: platform-admin; tomorrow: a self-
  // service signup), so placing the invariant where the tenant is BORN means
  // every future caller inherits personal-email rejection + domain-lock with
  // ZERO new validation logic. The owner's (non-personal) email domain
  // BECOMES the tenant's locked allowed_domain.
  async provisionTenant(args: {
    name: string;
    owner_email: string;
    actor_user_id: string;
    // Subdomain-Identity Directive A — the tenant's subdomain slug. Optional:
    // when supplied (a future self-service signup, or Directive B's provisioning
    // path) it is DNS-safe-validated HERE (the same service-layer placement as
    // allowed_domain, so every creation path inherits the invariant) and stored
    // normalized; when omitted, the tenant is created without a subdomain (slug
    // NULL) — exactly the pre-A behavior. Astre's slug is set by the seed, not
    // this path.
    slug?: string;
    // Inc-3 PR-3.4 (B2, audit honesty) — whether the owner's invitation email
    // was sent as part of this provision. Recorded in the `identity.tenant.created`
    // payload so an operator can distinguish "invited, waiting" from "created,
    // not yet invited" from the provision event alone. Optional: omitted by
    // non-platform callers (e.g. the seed) → the field is absent and the payload
    // is byte-equivalent to the pre-3.4 shape.
    invitation_sent?: boolean;
  }): Promise<TenantDto> {
    const existing = await this.tenantRepo.findByNameCaseInsensitive(args.name);
    if (existing !== null) {
      throw new AramoError(
        'TENANT_ALREADY_EXISTS',
        'A tenant with this name already exists',
        409,
        {
          requestId: 'provision',
          details: { name: args.name, existing_tenant_id: existing.id },
        },
      );
    }

    // Domain-Enforcement P1 — derive + validate the owner's domain (the
    // single-source gate; throws 4xx for an empty/personal/disposable domain).
    // The owner_email is @IsEmail-validated at the platform-admin DTO, but the
    // service stays authoritative so a future caller (self-service signup)
    // inherits the invariant. The surviving domain becomes the tenant's locked
    // allowed_domain (stored normalized).
    const allowed_domain = deriveAllowedDomainOrThrow(
      args.owner_email,
      'provision',
    );

    // Subdomain-Identity Directive A — validate the slug (if supplied) at the
    // same authoritative spine, throwing 4xx for a non-DNS-safe value. The
    // normalized (lowercased) form is what gets persisted to the UNIQUE column.
    const slug =
      args.slug === undefined
        ? undefined
        : deriveSlugOrThrow(args.slug, 'provision');

    const tenant_id = uuidv7();
    const tenant = await this.tenantRepo.createTenant({
      id: tenant_id,
      name: args.name,
      allowed_domain,
      slug,
    });
    await this.audit.writeEvent({
      event_type: 'identity.tenant.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: tenant.id,
      subject_id: tenant.id,
      payload: {
        name: args.name,
        source: 'platform.provision',
        allowed_domain,
        ...(slug === undefined ? {} : { slug }),
        ...(args.invitation_sent === undefined
          ? {}
          : { invitation_sent: args.invitation_sent }),
      },
    });
    return tenant;
  }

  // AUTHZ-2 (Lead ruling 7): soft-disable on entitlement-tx failure. The
  // identity-tx + Cognito records remain durable; the tenant becomes
  // inert (EntitlementGuard blocks all capability routes, JwtAuthGuard
  // /SessionOrchestrator refuse to issue tokens for an inactive tenant).
  async deactivateTenant(args: {
    tenant_id: string;
    actor_user_id: string;
    reason: string;
  }): Promise<void> {
    await this.tenantRepo.deactivateTenant({ id: args.tenant_id });
    await this.audit.writeEvent({
      event_type: 'identity.tenant.created',
      // Reuse the existing tenant-scoped event_type for the rollback
      // marker (the closed EVENT_TYPES set has no .deactivated entry; a
      // dedicated rollback event_type is a follow-on PR). The payload's
      // `rollback: true` + reason distinguishes this from a creation
      // event for downstream consumers.
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: args.tenant_id,
      payload: { rollback: true, reason: args.reason },
    });
  }

  // Platform-Console Increment-2 PR-1 (workstream C) — the lifecycle transition
  // service. The single authoritative path for every status change: reads the
  // current state, enforces the doc's transition table + reason guardrails,
  // stamps the milestone column, and emits the transition audit event (§B
  // payload shape). Illegal transitions hard-fail (VALIDATION_ERROR reason
  // `illegal_transition`) AND emit `tenant.lifecycle_transition_rejected`. A
  // request to the CURRENT state is an idempotent no-op (the activation hook's
  // race-safety) — no event, no error. Operator endpoints (suspend/reactivate/
  // start-offboarding/close) and the inline activation hook both call this;
  // there is no free-form status write.
  async transitionTenantStatus(args: {
    tenant_id: string;
    to: TenantStatus;
    actor_id: string;
    actor_type: 'user' | 'system';
    source: string;
    reason_code?: string;
    reason_text?: string;
    request_id?: string;
    related?: Record<string, unknown>;
    // OFFBOARDING-only (doc row 72: close date + retention policy code required).
    retention_policy_code?: string;
    close_at?: Date;
  }): Promise<{ from: TenantStatus; to: TenantStatus; changed: boolean }> {
    const requestId = args.request_id ?? 'tenant.lifecycle';
    const current = await this.tenantRepo.findLifecycleById(args.tenant_id);
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId,
        details: { tenant_id: args.tenant_id },
      });
    }
    if (!isTenantStatus(current.status)) {
      // Defensive: a status the code doesn't know is a data-integrity fault.
      throw new AramoError('INTERNAL_ERROR', 'Unknown tenant status', 500, {
        requestId,
        details: { tenant_id: args.tenant_id, status: current.status },
      });
    }
    const from = current.status;

    // Idempotent no-op when already in the target state (activation re-accept
    // race + operator double-click): no write, no event, no error.
    if (from === args.to) {
      return { from, to: args.to, changed: false };
    }

    // Transition legality (the doc's table). Illegal → rejected-event + throw.
    if (!isLegalTransition(from, args.to)) {
      await this.audit.writeEvent({
        event_type: 'tenant.lifecycle_transition_rejected',
        actor_type: args.actor_type,
        actor_id: args.actor_id,
        tenant_id: args.tenant_id,
        subject_id: args.tenant_id,
        payload: {
          before: { status: from, is_active: current.is_active },
          after: { status: args.to, is_active: current.is_active },
          reason: {
            code: 'illegal_transition',
            text: args.reason_text ?? null,
          },
          context: { source: args.source, requestId },
          related: args.related ?? {},
        },
      });
      throw new AramoError(
        'VALIDATION_ERROR',
        `Illegal tenant transition ${from} → ${args.to}`,
        422,
        { requestId, details: { reason: 'illegal_transition', from, to: args.to } },
      );
    }

    // Reason guardrails (P3 + doc row 72). SUSPEND needs code+text; reactivate
    // and CLOSE need code; OFFBOARDING needs retention policy code + close date.
    const requireReason = (needText: boolean): void => {
      if (args.reason_code === undefined || args.reason_code.length === 0) {
        throw invalidReason(requestId, 'reason_code_required');
      }
      if (needText && (args.reason_text === undefined || args.reason_text.length === 0)) {
        throw invalidReason(requestId, 'reason_text_required');
      }
    };
    if (args.to === 'SUSPENDED') requireReason(true);
    if (args.to === 'ACTIVE' && from === 'SUSPENDED') requireReason(false);
    if (args.to === 'CLOSED') requireReason(false);
    if (args.to === 'OFFBOARDING') {
      if (args.retention_policy_code === undefined || args.retention_policy_code.length === 0) {
        throw invalidReason(requestId, 'retention_policy_code_required');
      }
      if (args.close_at === undefined) {
        throw invalidReason(requestId, 'close_at_required');
      }
    }

    // Milestone stamp per transition.
    const now = new Date();
    const patch: Parameters<TenantRepository['updateStatus']>[1] = {
      status: args.to,
      status_reason_code: args.reason_code ?? null,
      status_reason_text: args.reason_text ?? null,
      status_changed_at: now,
    };
    if (args.to === 'ACTIVE' && from === 'PROVISIONED') {
      patch.activated_at = now;
      patch.owner_accepted_at = now;
    }
    if (args.to === 'SUSPENDED') patch.suspended_at = now;
    if (args.to === 'OFFBOARDING') {
      patch.offboarding_started_at = now;
      patch.retention_policy_code = args.retention_policy_code ?? null;
      patch.retention_delete_after = args.close_at ?? null;
    }
    if (args.to === 'CLOSED') patch.closed_at = now;

    await this.tenantRepo.updateStatus(args.tenant_id, patch);

    // Success event (map target state → event_type; §B structured payload).
    const eventByTarget: Record<TenantStatus, EventType | null> = {
      PROVISIONED: null,
      ACTIVE: from === 'PROVISIONED' ? 'tenant.activated' : 'tenant.reactivated',
      SUSPENDED: 'tenant.suspended',
      OFFBOARDING: 'tenant.offboarding_started',
      CLOSED: 'tenant.closed',
    };
    const event_type = eventByTarget[args.to];
    if (event_type !== null) {
      await this.audit.writeEvent({
        event_type,
        actor_type: args.actor_type,
        actor_id: args.actor_id,
        tenant_id: args.tenant_id,
        subject_id: args.tenant_id,
        payload: {
          before: { status: from, is_active: current.is_active },
          after: { status: args.to, is_active: current.is_active },
          reason: {
            code: args.reason_code ?? null,
            text: args.reason_text ?? null,
          },
          context: { source: args.source, requestId },
          related: args.related ?? {},
        },
      });
    }
    return { from, to: args.to, changed: true };
  }
}

function invalidReason(requestId: string, reason: string): AramoError {
  return new AramoError('VALIDATION_ERROR', 'Transition reason required', 422, {
    requestId,
    details: { reason },
  });
}

// Inc-3 PR-3.8 (A) — lift a human-facing reason code out of a lifecycle event's
// payload for the dashboard feed. Lifecycle transitions carry `reason: {code,
// text}`; the owner-invite event carries `reason: '<first_send|resend>'`; other
// events may omit it. Returns null when no code is present (never guesses).
function extractReasonCode(payload: Record<string, unknown>): string | null {
  const reason = payload['reason'];
  if (typeof reason === 'string') return reason.length > 0 ? reason : null;
  if (reason !== null && typeof reason === 'object' && 'code' in reason) {
    const code = (reason as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  }
  return null;
}

// Inc-3 PR-3.8 (A) — the operator dashboard payload shape (returned by
// getPlatformDashboard, rendered by platform-web). Counts / ages / statuses /
// events only (R10): no numeric rating of any tenant.
export interface PlatformDashboardStatusCount {
  readonly status: TenantStatus;
  readonly count: number;
}

export interface PlatformDashboardOnboardingRow {
  readonly tenant_id: string;
  readonly name: string;
  readonly created_at: string;
  /** Audit-derived: has a `tenant.owner_invite.sent` ever been recorded. */
  readonly invited: boolean;
}

export interface PlatformDashboardActivityRow {
  readonly event_type: string;
  readonly tenant_id: string | null;
  readonly tenant_name: string | null;
  readonly actor_type: string;
  readonly reason_code: string | null;
  readonly created_at: string;
}

export interface PlatformDashboardData {
  readonly status_counts: readonly PlatformDashboardStatusCount[];
  readonly onboarding: readonly PlatformDashboardOnboardingRow[];
  readonly recent_activity: readonly PlatformDashboardActivityRow[];
}
