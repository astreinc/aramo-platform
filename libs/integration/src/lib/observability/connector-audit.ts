import { Injectable } from '@nestjs/common';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { redactForLog } from './redact.js';

// T8-CONNECTOR-A — connector audit/observability (directive §26). REUSES the
// existing workspace structured logger (createAramoLogger → CloudWatch, ADR-0013)
// — NO new persisted audit-event TYPE is introduced (event-count delta = 0). Every
// payload is routed through the secret-safe redactor, so credential material and
// provider payloads can never be emitted.

/** The connector audit event names (structured-log `event` discriminators). */
export const CONNECTOR_AUDIT_EVENTS = {
  CONNECTION_CREATED: 'connector.connection.created',
  CONNECTION_UPDATED: 'connector.connection.updated',
  CONNECTION_ENABLED: 'connector.connection.enabled',
  CONNECTION_DISABLED: 'connector.connection.disabled',
  CREDENTIAL_SET: 'connector.connection.credential_set',
  EXECUTION_ATTEMPTED: 'connector.execution.attempted',
  EXECUTION_SUCCEEDED: 'connector.execution.succeeded',
  EXECUTION_FAILED: 'connector.execution.failed',
  DELIVERY_ALREADY_PROCESSED: 'connector.delivery.already_processed',
  UNSUPPORTED_UPDATE_DETECTED: 'connector.delivery.unsupported_update',
  // L1-D3-A (R1) — mapping-set administration audit (DoD #18). Structured-log
  // discriminators only (no new persisted type). Secret-free by construction.
  LIFECYCLE_MAPPING_DRAFT_CREATED: 'connector.lifecycle_mapping.draft_created',
  LIFECYCLE_MAPPING_DRAFT_UPDATED: 'connector.lifecycle_mapping.draft_updated',
  LIFECYCLE_MAPPING_ACTIVATED: 'connector.lifecycle_mapping.activated',
} as const;

export type ConnectorAuditEvent =
  (typeof CONNECTOR_AUDIT_EVENTS)[keyof typeof CONNECTOR_AUDIT_EVENTS];

@Injectable()
export class ConnectorAuditLog {
  private readonly logger: AramoLogger = createAramoLogger('ConnectorAudit');

  /** Emit a secret-free structured audit event. Payload is redacted defensively. */
  emit(event: ConnectorAuditEvent, payload: Record<string, unknown>): void {
    const safe = redactForLog(payload) as Record<string, unknown>;
    this.logger.log({ event, ...safe });
  }
}
