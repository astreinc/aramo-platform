import { Injectable, Logger } from '@nestjs/common';

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
  private readonly logger = new Logger(IdentityAuditService.name);

  constructor(private readonly auditRepo: IdentityAuditRepository) {}

  async writeEvent(params: {
    event_type: EventType;
    actor_type: 'user';
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
      this.logger.warn(
        `IdentityAuditService.writeEvent failed: ${(err as Error).message}`,
        {
          event_type: params.event_type,
          actor_id: params.actor_id,
          tenant_id: params.tenant_id,
          subject_id: params.subject_id,
        },
      );
    }
  }
}
