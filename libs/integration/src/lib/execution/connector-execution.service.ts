import { Injectable, Logger, Optional } from '@nestjs/common';

import { ConnectorAuditLog, CONNECTOR_AUDIT_EVENTS } from '../observability/connector-audit.js';
import { IntegrationConnectionRepository } from '../connection/integration-connection.repository.js';
import { ConnectorAdapterRegistry } from '../adapter/connector-adapter.registry.js';
import { ConnectorSecretResolver } from '../secrets/connector-secret-resolver.js';
import { redactString } from '../observability/redact.js';

import {
  ConnectorExecutionOrchestrator,
  type ConnectorExecutionOutcome,
} from './connector-execution.orchestrator.js';
import { ConnectorTransientError, shouldRetry } from './failure-taxonomy.js';

// T8-CONNECTOR-A — the connector execution entry the BullMQ processor calls
// (directive §9/§17, Architect check #4). It DELIBERATELY translates domain
// outcomes into the retry decision: a transient failure is re-thrown so BullMQ
// retries within the bounded attempts; every terminal outcome (PROCESSED /
// ALREADY_PROCESSED / UNSUPPORTED / permanent FAILED) is RETURNED, never thrown,
// so BullMQ does NOT auto-retry it. The DB delivery ledger stays authoritative
// even if BullMQ redelivers the job.

export interface ConnectorJobInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly requestId: string;
}

@Injectable()
export class ConnectorExecutionService {
  private readonly logger = new Logger('ConnectorExecutionService');

  constructor(
    private readonly connections: IntegrationConnectionRepository,
    private readonly resolver: ConnectorSecretResolver,
    private readonly adapters: ConnectorAdapterRegistry,
    private readonly orchestrator: ConnectorExecutionOrchestrator,
    @Optional() private readonly audit?: ConnectorAuditLog,
  ) {}

  async runDelivery(input: ConnectorJobInput): Promise<ConnectorExecutionOutcome> {
    await this.connections.recordAttempt(input.tenant_id, input.connection_id);
    this.audit?.emit(CONNECTOR_AUDIT_EVENTS.EXECUTION_ATTEMPTED, {
      tenant_id: input.tenant_id,
      connection_id: input.connection_id,
    });
    try {
      const conn = await this.connections.findByIdForTenant(input.tenant_id, input.connection_id);
      if (conn === null) {
        // Permanent: the connection no longer exists — no retry.
        return this.permanent('CONNECTION_NOT_FOUND');
      }

      const adapter = this.adapters.resolve(conn.provider_key);
      if (adapter === null) {
        await this.connections.recordError(
          input.tenant_id,
          input.connection_id,
          'CONNECTOR_CONFIGURATION_INVALID',
          `no adapter registered for provider ${conn.provider_key}`,
        );
        return this.permanent('CONNECTOR_CONFIGURATION_INVALID');
      }

      // Tenant-bound secret resolution (ephemeral; never persisted/logged).
      const credential =
        conn.secret_ref === null
          ? null
          : await this.resolver.resolveForExecution({
              tenant_id: input.tenant_id,
              connection_id: input.connection_id,
            });

      const result = await adapter.fetchExecutionInput({
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        provider_key: conn.provider_key,
        cursor: conn.cursor,
        credential,
      });

      const outcome = await this.orchestrator.execute({
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        provider_key: conn.provider_key,
        delivery_key: result.delivery_key,
        records: result.records,
        requestId: input.requestId,
      });

      // Governed connection-status update by outcome (execution-driven).
      if (outcome.outcome === 'PROCESSED') {
        await this.connections.recordSuccess(input.tenant_id, input.connection_id);
      } else if (outcome.outcome === 'FAILED') {
        await this.connections.recordError(
          input.tenant_id,
          input.connection_id,
          outcome.detail_code,
          'canonical import failed',
        );
      }
      // UNSUPPORTED / ALREADY_PROCESSED are delivery-level dispositions and do
      // not degrade the connection.
      this.emitOutcome(input, outcome);
      return outcome;
    } catch (err) {
      const summary = redactString(err instanceof Error ? err.message : 'connector execution error');
      if (shouldRetry(err)) {
        // Transient — degrade + RE-THROW so BullMQ retries within the bound.
        await this.connections.recordError(
          input.tenant_id,
          input.connection_id,
          'CONNECTOR_EXECUTION_UNAVAILABLE',
          summary,
        );
        this.logger.warn(`connector transient failure (will retry): ${summary}`);
        throw err;
      }
      // Permanent — degrade + RETURN (no re-throw → BullMQ does not retry).
      await this.connections.recordError(
        input.tenant_id,
        input.connection_id,
        'CONNECTOR_EXECUTION_FAILED',
        summary,
      );
      return this.permanent('CONNECTOR_EXECUTION_FAILED');
    }
  }

  private emitOutcome(input: ConnectorJobInput, outcome: ConnectorExecutionOutcome): void {
    const base = { tenant_id: input.tenant_id, connection_id: input.connection_id };
    switch (outcome.outcome) {
      case 'PROCESSED':
        this.audit?.emit(CONNECTOR_AUDIT_EVENTS.EXECUTION_SUCCEEDED, {
          ...base,
          import_batch_id: outcome.import_batch_id,
        });
        break;
      case 'ALREADY_PROCESSED':
        this.audit?.emit(CONNECTOR_AUDIT_EVENTS.DELIVERY_ALREADY_PROCESSED, base);
        break;
      case 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE':
        this.audit?.emit(CONNECTOR_AUDIT_EVENTS.UNSUPPORTED_UPDATE_DETECTED, base);
        break;
      case 'FAILED':
        this.audit?.emit(CONNECTOR_AUDIT_EVENTS.EXECUTION_FAILED, {
          ...base,
          detail_code: outcome.detail_code,
        });
        break;
    }
  }

  private permanent(detail: string): ConnectorExecutionOutcome {
    return { outcome: 'FAILED', import_batch_id: null, retryable: false, detail_code: detail };
  }
}

// Re-export the transient marker so callers/tests can signal retryable failures.
export { ConnectorTransientError };
