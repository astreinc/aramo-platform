import type { DeliveryStatus } from '../domain/integration-connection.js';

// T8-CONNECTOR-A — the durable transport-delivery idempotency ledger port
// (directive §15, Architect check #2). The DATABASE row (unique on
// (tenant_id, connection_id, delivery_key)) is the AUTHORITY on whether a
// delivery was already processed — not the BullMQ jobId.

export interface DeliveryLedgerRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly delivery_key: string;
  readonly status: DeliveryStatus;
  readonly import_batch_id: string | null;
  readonly detail_code: string | null;
}

export interface DeliveryReservation {
  /** true → this caller inserted the pending row; false → a row already existed. */
  readonly reserved: boolean;
  readonly row: DeliveryLedgerRow;
}

export interface DeliveryLedgerPort {
  findByKey(
    tenantId: string,
    connectionId: string,
    deliveryKey: string,
  ): Promise<DeliveryLedgerRow | null>;

  /**
   * Insert a `pending` delivery row. The unique constraint makes this the
   * race-safe authority: a concurrent duplicate insert yields `reserved:false`
   * plus the existing row (which the caller re-inspects).
   */
  reserve(args: {
    tenant_id: string;
    connection_id: string;
    delivery_key: string;
  }): Promise<DeliveryReservation>;

  markProcessed(id: string, importBatchId: string): Promise<void>;
  markUnsupported(id: string, detailCode: string): Promise<void>;
  markFailed(id: string, detailCode: string): Promise<void>;
}

export const DELIVERY_LEDGER = Symbol('DELIVERY_LEDGER');
