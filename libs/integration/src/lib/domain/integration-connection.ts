// T8-CONNECTOR-A — provider-neutral connection domain types + lifecycle
// (directive §13/§14/§33). No provider vocabulary is frozen here.

/** Connection lifecycle (repository-convention lowercase; directive §14). */
export const CONNECTION_STATUSES = [
  'disconnected',
  'configured',
  'active',
  'degraded',
  'disabled',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Transport-delivery disposition (directive §15/§19/§41). */
export const DELIVERY_STATUSES = ['pending', 'processed', 'failed', 'unsupported'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The bounded, non-secret classification token recorded when a delivery targets
 * an EXISTING external identity with changed business content — a business
 * amendment, which is unsupported/deferred (directive §41). Implementation-owned
 * token; observable/admin-reviewable; NEVER a requisition mutation.
 */
export const UNSUPPORTED_EXISTING_REQUISITION_UPDATE =
  'UNSUPPORTED_EXISTING_REQUISITION_UPDATE' as const;

const PROVIDER_KEY_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
export const MAX_PROVIDER_KEY_LENGTH = 64;

/**
 * Normalize a provider key to the extensible canonical form (directive §4/§33):
 * a lowercase token, NEVER a closed enum. Rejects empty / over-length / invalid
 * shapes so no vendor-specific or path-like value slips in.
 */
export function normalizeProviderKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key.length === 0 || key.length > MAX_PROVIDER_KEY_LENGTH) {
    throw new Error('invalid provider_key: length');
  }
  if (!PROVIDER_KEY_RE.test(key)) {
    throw new Error('invalid provider_key: shape');
  }
  return key;
}

/** Persisted connection row (mirrors the Prisma model; includes secret_ref). */
export interface IntegrationConnectionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly status: ConnectionStatus;
  readonly secret_ref: string | null;
  readonly config: unknown;
  readonly provider_account_id: string | null;
  readonly cursor: string | null;
  readonly last_attempted_at: Date | null;
  readonly last_successful_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_error_summary: string | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Public connection view — the browser/API shape. Deliberately OMITS
 * `secret_ref` entirely (directive §7/§34): the frontend may know credentials
 * EXIST (`has_secret`) but never the reference or any secret material.
 */
export interface IntegrationConnectionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly provider_key: string;
  readonly status: ConnectionStatus;
  readonly has_secret: boolean;
  readonly provider_account_id: string | null;
  readonly last_attempted_at: string | null;
  readonly last_successful_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_summary: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Project a row to the secret-free public view (never leaks secret_ref). */
export function toConnectionView(row: IntegrationConnectionRow): IntegrationConnectionView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider_key: row.provider_key,
    status: row.status,
    has_secret: row.secret_ref !== null,
    provider_account_id: row.provider_account_id,
    last_attempted_at: row.last_attempted_at?.toISOString() ?? null,
    last_successful_at: row.last_successful_at?.toISOString() ?? null,
    last_error_code: row.last_error_code,
    last_error_summary: row.last_error_summary,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
