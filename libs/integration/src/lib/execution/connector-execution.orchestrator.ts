import { Inject, Injectable } from '@nestjs/common';
import type { CanonicalRequisitionImportRecord } from '@aramo/import';

import {
  CONNECTOR_EXECUTION_SCOPES,
  CONNECTOR_SERVICE_ACCOUNT_ID,
  connectorImportSourceLabel,
} from '../domain/connector-actor.js';
import { UNSUPPORTED_EXISTING_REQUISITION_UPDATE } from '../domain/integration-connection.js';
import {
  EXTERNAL_IDENTITY_CONFLICT_REASON,
  REQUISITION_IMPORT_HANDOFF,
  type RequisitionImportHandoffPort,
} from '../handoff/requisition-import-handoff.port.js';

import { DELIVERY_LEDGER, type DeliveryLedgerPort } from './delivery-ledger.port.js';

// T8-CONNECTOR-A — connector execution orchestrator (directive §11/§15/§19/§41,
// Architect checks #2 + #3).
//
// Guarantees:
//   * the DB delivery ledger is the idempotency AUTHORITY — an already-processed
//     delivery_key returns ALREADY_PROCESSED and the P2 handoff is NEVER invoked
//     again (no second ImportBatch);
//   * a changed-content delivery for an EXISTING external identity is classified
//     UNSUPPORTED_EXISTING_REQUISITION_UPDATE — no requisition mutation, no
//     infinite retry (marked terminal);
//   * the P2 handoff runs as the CONNECTOR ServiceAccount (machine actor), never
//     a human.

export type ConnectorExecutionOutcome =
  | { readonly outcome: 'ALREADY_PROCESSED'; readonly import_batch_id: string | null }
  | { readonly outcome: 'PROCESSED'; readonly import_batch_id: string }
  | {
      readonly outcome: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE';
      readonly import_batch_id: string | null;
    }
  | {
      readonly outcome: 'FAILED';
      readonly import_batch_id: string | null;
      readonly retryable: boolean;
      readonly detail_code: string;
    };

export interface ConnectorExecutionInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly provider_key: string;
  /** Provider-neutral idempotency key for this transport delivery. */
  readonly delivery_key: string;
  readonly records: readonly CanonicalRequisitionImportRecord[];
  readonly requestId: string;
}

@Injectable()
export class ConnectorExecutionOrchestrator {
  constructor(
    @Inject(DELIVERY_LEDGER) private readonly ledger: DeliveryLedgerPort,
    @Inject(REQUISITION_IMPORT_HANDOFF)
    private readonly handoff: RequisitionImportHandoffPort,
  ) {}

  async execute(input: ConnectorExecutionInput): Promise<ConnectorExecutionOutcome> {
    const { tenant_id, connection_id, delivery_key } = input;

    // 1. Durable idempotency: the DB ledger is the authority (NOT the jobId).
    const existing = await this.ledger.findByKey(tenant_id, connection_id, delivery_key);
    const terminal = existing === null ? null : this.terminalOutcome(existing.status, existing.import_batch_id);
    if (terminal !== null) {
      return terminal; // already processed / already-classified-unsupported → no re-handoff
    }

    // 2. Reserve the delivery (insert `pending`). The unique constraint makes
    //    this race-safe: a lost race re-inspects the winner's terminal state.
    let deliveryId: string;
    if (existing !== null) {
      deliveryId = existing.id; // a prior `pending`/`failed` attempt — retry it
    } else {
      const res = await this.ledger.reserve({ tenant_id, connection_id, delivery_key });
      if (!res.reserved) {
        const raced = this.terminalOutcome(res.row.status, res.row.import_batch_id);
        if (raced !== null) {
          return raced;
        }
      }
      deliveryId = res.row.id;
    }

    // 3. Canonical CREATE-only handoff as the connector ServiceAccount (machine).
    const batch = await this.handoff.run({
      tenant_id,
      imported_by_id: CONNECTOR_SERVICE_ACCOUNT_ID,
      input: {
        source_label: connectorImportSourceLabel(input.provider_key, connection_id),
        records: [...input.records],
      },
      scopes: CONNECTOR_EXECUTION_SCOPES,
      requestId: input.requestId,
    });

    // 4. Classify the outcome.
    if (batch.failure_count === 0) {
      await this.ledger.markProcessed(deliveryId, batch.id);
      return { outcome: 'PROCESSED', import_batch_id: batch.id };
    }

    const failures = await this.handoff.listFailures({
      tenant_id,
      import_batch_id: batch.id,
      requestId: input.requestId,
    });
    const identityConflict = failures.some(
      (f) => f.failure_reason === EXTERNAL_IDENTITY_CONFLICT_REASON,
    );

    if (identityConflict && batch.success_count === 0) {
      // Existing external identity + changed content (this delivery_key differs
      // from the already-processed one) = a business AMENDMENT. P2 is CREATE-only,
      // so NO mutation occurred — the record was rejected, not updated. Terminal:
      // no infinite retry.
      await this.ledger.markUnsupported(deliveryId, UNSUPPORTED_EXISTING_REQUISITION_UPDATE);
      return {
        outcome: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE',
        import_batch_id: batch.id,
      };
    }

    // Other canonical validation/mapping failures are permanent — retry cannot
    // change the outcome (directive §17). Terminal.
    const detail = failures[0]?.failure_reason ?? 'CONNECTOR_IMPORT_FAILED';
    await this.ledger.markFailed(deliveryId, detail);
    return { outcome: 'FAILED', import_batch_id: batch.id, retryable: false, detail_code: detail };
  }

  private terminalOutcome(
    status: string,
    importBatchId: string | null,
  ): ConnectorExecutionOutcome | null {
    if (status === 'processed') {
      return { outcome: 'ALREADY_PROCESSED', import_batch_id: importBatchId };
    }
    if (status === 'unsupported') {
      return {
        outcome: 'UNSUPPORTED_EXISTING_REQUISITION_UPDATE',
        import_batch_id: importBatchId,
      };
    }
    return null;
  }
}
