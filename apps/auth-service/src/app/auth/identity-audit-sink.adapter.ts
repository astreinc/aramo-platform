import { Injectable, Logger } from '@nestjs/common';
import { IdentityAuditService } from '@aramo/identity';
import type { AuditRecord, AuditSink } from '@aramo/auth-core';

// The event_type strings auth emits are members of the identity audit EventType
// enum; the port carries them as opaque strings, so the adapter casts at the seam.
type AuditEventType = Parameters<IdentityAuditService['writeEvent']>[0]['event_type'];

// Auth-Decoupling PR-4 (ADR-0021 §2) — the Aramo-side adapter implementing auth's
// AuditSink over @aramo/identity's IdentityAuditService. `context_id` present →
// tenant-scoped writeEvent; absent → writeGlobalEvent. actor_type is 'user' for
// every event auth emits (session issued/refreshed/reuse/revoked), matching the
// prior inline calls exactly.
//
// R-P4-2 — record MUST NEVER THROW. The underlying writeEvent/writeGlobalEvent
// already swallow repository errors; the try/catch here is a belt-and-braces
// guarantee so no future change to the audit service can make an audit failure
// break a login/refresh/logout. This is the ONLY audit seam auth calls;
// session-orchestrator / refresh-orchestrator / auth.controller no longer import
// IdentityAuditService (the §3.4 decoupling proof).
@Injectable()
export class IdentityAuditSinkAdapter implements AuditSink {
  private readonly logger = new Logger(IdentityAuditSinkAdapter.name);

  constructor(private readonly audit: IdentityAuditService) {}

  async record(event: AuditRecord): Promise<void> {
    try {
      const event_type = event.event_type as AuditEventType;
      const payload = event.payload ?? {};
      if (event.context_id !== undefined) {
        await this.audit.writeEvent({
          event_type,
          actor_type: 'user',
          actor_id: event.actor_id,
          tenant_id: event.context_id,
          subject_id: event.subject_id,
          payload,
        });
      } else {
        await this.audit.writeGlobalEvent({
          event_type,
          actor_type: 'user',
          actor_id: event.actor_id,
          subject_id: event.subject_id,
          payload,
        });
      }
    } catch (err) {
      // R-P4-2: never throw. Best-effort audit; a failure must not break the flow.
      this.logger.warn(
        `audit sink record failed (non-blocking): ${(err as Error).message}`,
      );
    }
  }
}
