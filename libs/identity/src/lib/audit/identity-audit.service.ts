import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import {
  IdentityAuditRepository,
  type EventType,
} from './identity-audit.repository.js';

// PR-8.0a-Reground §3 Topic 1 + §7. Best-effort audit emission. The wrapper
// swallows repository errors and logs at warn level so auth flows never block
// on audit failures. event_type is typed as EventType (closed-set alias) —
// callers cannot pass arbitrary strings; compile-time check prevents drift.
@Injectable()
export class IdentityAuditService {
  constructor(
    private readonly auditRepo: IdentityAuditRepository,
    // M4-close HK-PR-4 — Style A constructor DI for structured logger.
    // Provider lives in IdentityModule keyed by the 'IdentityAuditServiceLogger'
    // token; factory context is IdentityAuditService.name.
    @Inject('IdentityAuditServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async writeEvent(params: {
    event_type: EventType;
    actor_type: 'user' | 'system' | 'provider';
    actor_id: string;
    tenant_id: string;
    subject_id: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditRepo.writeEvent({
        event_type: params.event_type,
        actor_type: params.actor_type,
        actor_id: params.actor_id,
        tenant_id: params.tenant_id,
        subject_id: params.subject_id,
        event_payload: params.payload,
      });
    } catch (err) {
      this.logger.warn({
        event: 'identity_audit_write_failed',
        error_message: (err as Error).message,
        event_type: params.event_type,
        actor_id: params.actor_id,
        tenant_id: params.tenant_id,
        subject_id: params.subject_id,
      });
    }
  }

  // Inc-3 PR-3.4 — existence probe over the tenant's audit ledger for a given
  // event_type. Read-only (no new endpoint/scope/migration): used to derive the
  // owner-invite send reason (first_send vs resend) from history — whether a
  // `tenant.owner_invite.sent` has ever been recorded for the tenant. Unlike
  // writeEvent this does NOT swallow errors — a read failure here would silently
  // mislabel the audit reason, so it surfaces to the caller.
  async hasTenantEvent(
    tenant_id: string,
    event_type: EventType,
  ): Promise<boolean> {
    const rows = await this.auditRepo.findByTenant({
      tenant_id,
      limit: 1,
      filters: { event_type },
    });
    return rows.length > 0;
  }

  // Inc-3 PR-3.8 (A) — the dashboard recent-activity read: the most recent
  // tenant.* lifecycle events across ALL tenants, capped. Read-only, cross-estate
  // (the operator view); errors surface (unlike writeEvent) so a failed read is
  // not silently rendered as an empty feed. Delegates to the repository's
  // cross-tenant query.
  async getRecentTenantLifecycleActivity(
    limit: number,
  ): Promise<import('./identity-audit.repository.js').AuditEventRow[]> {
    return this.auditRepo.findRecentTenantLifecycleActivity(limit);
  }

  // AUTHZ-2: global-event emission (tenant_id=null). The repository's
  // assertMappingObeyed enforces that the event_type is NOT in
  // TENANT_SCOPED_EVENT_TYPES (directive §6 closed mapping). Used by
  // IdentityService.createUserFromInvitation for identity.user.created +
  // identity.external_identity.linked (both global per the mapping).
  async writeGlobalEvent(params: {
    event_type: EventType;
    actor_type: 'user' | 'system' | 'provider';
    actor_id: string;
    subject_id: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditRepo.writeEvent({
        event_type: params.event_type,
        actor_type: params.actor_type,
        actor_id: params.actor_id,
        tenant_id: null,
        subject_id: params.subject_id,
        event_payload: params.payload,
      });
    } catch (err) {
      this.logger.warn({
        event: 'identity_audit_write_failed',
        error_message: (err as Error).message,
        event_type: params.event_type,
        actor_id: params.actor_id,
        subject_id: params.subject_id,
      });
    }
  }
}
