import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import type { EventType } from './audit/identity-audit.repository.js';
import type { TenantDto } from './dto/tenant.dto.js';
import { TenantRepository } from './tenant.repository.js';
import { deriveAllowedDomainOrThrow } from './util/email-domain.js';
import { deriveSlugOrThrow } from './util/tenant-slug.js';
import {
  isLegalTransition,
  isTenantStatus,
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
