import type { ImportBatchView } from '@aramo/import';

import type { SecretsManagerPort } from '../../lib/secrets/secrets-manager.port.js';
import type { ConnectionSecretLoaderPort } from '../../lib/secrets/connector-secret-resolver.js';
import type {
  DeliveryLedgerPort,
  DeliveryLedgerRow,
  DeliveryReservation,
} from '../../lib/execution/delivery-ledger.port.js';
import type {
  HandoffFailure,
  RequisitionImportHandoffPort,
} from '../../lib/handoff/requisition-import-handoff.port.js';
import type {
  ConnectorAdapter,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
} from '../../lib/adapter/connector-adapter.port.js';

// Test doubles for the connector secret path. Deterministic; no AWS, no network.

/** Records every secret id requested so specs can assert it was NEVER reached. */
export class FakeSecretsManager implements SecretsManagerPort {
  readonly requested: string[] = [];
  constructor(private readonly store: Record<string, string> = {}) {}

  async getSecretValue(secretId: string): Promise<string> {
    this.requested.push(secretId);
    const value = this.store[secretId];
    if (value === undefined) {
      throw new Error(`fake SM: no value for ${secretId}`);
    }
    return value;
  }
}

/** A tenant-scoped connection loader that models tenant-safe row visibility. */
export class FakeConnectionLoader implements ConnectionSecretLoaderPort {
  constructor(
    private readonly rows: ReadonlyArray<{
      id: string;
      tenant_id: string;
      secret_ref: string | null;
    }>,
  ) {}

  async findConnectionForTenant(
    tenantId: string,
    connectionId: string,
  ): Promise<{ id: string; tenant_id: string; secret_ref: string | null } | null> {
    // Tenant-safe: only returns a row whose tenant_id matches the caller.
    const row = this.rows.find((r) => r.id === connectionId && r.tenant_id === tenantId);
    return row ?? null;
  }
}

let deliveryCounter = 0;

/** In-memory delivery ledger modelling the UNIQUE(tenant, connection, key) authority. */
export class FakeDeliveryLedger implements DeliveryLedgerPort {
  private readonly rows = new Map<string, DeliveryLedgerRow>();

  private key(t: string, c: string, k: string): string {
    return `${t}|${c}|${k}`;
  }

  seed(row: DeliveryLedgerRow): void {
    this.rows.set(this.key(row.tenant_id, row.connection_id, row.delivery_key), row);
  }

  async findByKey(
    tenantId: string,
    connectionId: string,
    deliveryKey: string,
  ): Promise<DeliveryLedgerRow | null> {
    return this.rows.get(this.key(tenantId, connectionId, deliveryKey)) ?? null;
  }

  async reserve(args: {
    tenant_id: string;
    connection_id: string;
    delivery_key: string;
  }): Promise<DeliveryReservation> {
    const k = this.key(args.tenant_id, args.connection_id, args.delivery_key);
    const existing = this.rows.get(k);
    if (existing !== undefined) {
      return { reserved: false, row: existing };
    }
    deliveryCounter += 1;
    const row: DeliveryLedgerRow = {
      id: `delivery-${deliveryCounter}`,
      tenant_id: args.tenant_id,
      connection_id: args.connection_id,
      delivery_key: args.delivery_key,
      status: 'pending',
      import_batch_id: null,
      detail_code: null,
    };
    this.rows.set(k, row);
    return { reserved: true, row };
  }

  private update(id: string, patch: Partial<DeliveryLedgerRow>): void {
    for (const [k, row] of this.rows) {
      if (row.id === id) {
        this.rows.set(k, { ...row, ...patch });
        return;
      }
    }
  }

  async markProcessed(id: string, importBatchId: string): Promise<void> {
    this.update(id, { status: 'processed', import_batch_id: importBatchId });
  }
  async markUnsupported(id: string, detailCode: string): Promise<void> {
    this.update(id, { status: 'unsupported', detail_code: detailCode });
  }
  async markFailed(id: string, detailCode: string): Promise<void> {
    this.update(id, { status: 'failed', detail_code: detailCode });
  }

  snapshot(): DeliveryLedgerRow[] {
    return [...this.rows.values()];
  }
}

/** Records handoff invocations; returns scripted ImportBatchView + failures. */
export class FakeHandoff implements RequisitionImportHandoffPort {
  readonly runCalls: Array<{
    tenant_id: string;
    imported_by_id: string;
    scopes: readonly string[];
    source_label: string;
    record_count: number;
  }> = [];

  constructor(
    private readonly script: {
      batch: ImportBatchView;
      failures?: readonly HandoffFailure[];
    },
  ) {}

  async run(args: {
    tenant_id: string;
    imported_by_id: string;
    input: { source_label: string; records: unknown[] };
    scopes: readonly string[];
    requestId: string;
  }): Promise<ImportBatchView> {
    this.runCalls.push({
      tenant_id: args.tenant_id,
      imported_by_id: args.imported_by_id,
      scopes: args.scopes,
      source_label: args.input.source_label,
      record_count: args.input.records.length,
    });
    return this.script.batch;
  }

  async listFailures(): Promise<readonly HandoffFailure[]> {
    return this.script.failures ?? [];
  }
}

/** Deterministic fake adapter (directive §50 — test-only, NOT vendor-shaped). */
export class FakeConnectorAdapter implements ConnectorAdapter {
  readonly providerKey = 'fake';
  readonly calls: ConnectorExecutionContext[] = [];

  constructor(private readonly result: ConnectorExecutionResult) {}

  async fetchExecutionInput(ctx: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    this.calls.push(ctx);
    return this.result;
  }
}
