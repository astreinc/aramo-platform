import type { CanonicalRequisitionImportRecord } from '@aramo/import';

// T8-CONNECTOR-A — provider-neutral adapter contract (directive §12). The adapter
// is the ONLY place provider-specific parsing/mapping is allowed; its output is
// canonical records + a transport idempotency key. Connector-A ships NO real
// vendor adapter — only a deterministic fake for tests (directive §50).

export interface ConnectorExecutionContext {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly provider_key: string;
  /** Opaque bounded cursor/watermark for polling transports (directive §16). */
  readonly cursor: string | null;
  /**
   * The resolved credential, if the connection has one. Resolved SERVER-SIDE by
   * the tenant-bound resolver and passed in ephemerally; never persisted/logged.
   */
  readonly credential: string | null;
}

export interface ConnectorExecutionResult {
  /** Provider-neutral transport idempotency key for this delivery (directive §15). */
  readonly delivery_key: string;
  readonly records: readonly CanonicalRequisitionImportRecord[];
  /** Advanced only after successful processing (directive §16). */
  readonly next_cursor?: string | null;
}

export interface ConnectorAdapter {
  /** Extensible provider key — NEVER a frozen vendor enum. */
  readonly providerKey: string;
  /** Fetch/receive a provider-neutral execution input and return canonical records. */
  fetchExecutionInput(ctx: ConnectorExecutionContext): Promise<ConnectorExecutionResult>;
}
