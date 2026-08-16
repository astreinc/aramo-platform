// T8-CONNECTOR-A — opaque, tenant-bound connector secret references (directive
// §7/§8, Architect ruling #3).
//
// The load-bearing isolation property: the AWS Secrets Manager id is ALWAYS
// derived server-side from the CONNECTION'S OWN (tenant_id, connection_id) —
// values that were loaded tenant-first from Postgres — never from client input
// and never from a browser-supplied `aramo/...` path. A tenant therefore cannot
// point at another tenant's secret by manipulating API input: the only client
// input is a connection id, which is resolved through a tenant-scoped lookup;
// a connection belonging to another tenant is simply not found.
//
// `secret_ref` (stored in Postgres) is opaque metadata that additionally EMBEDS
// the (tenant_id, connection_id) binding so the resolver can defensively assert
// it matches the connection being executed before any secret resolution. It is
// SERVER-GENERATED and never returned to the browser.

/** Current opaque secret-ref envelope version. */
export const CONNECTOR_SECRET_REF_VERSION = 'v1' as const;

/** Prefix marking a value as an Aramo connector secret reference. */
export const CONNECTOR_SECRET_REF_PREFIX = 'connector' as const;

export interface ConnectorSecretRefBinding {
  readonly tenant_id: string;
  readonly connection_id: string;
}

export interface ParsedConnectorSecretRef extends ConnectorSecretRefBinding {
  readonly version: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the opaque, server-generated secret reference for a connection.
 * Shape: `connector:v1:<tenant_id>:<connection_id>`. Never derived from client
 * input; never returned to the frontend.
 */
export function buildConnectorSecretRef(
  binding: ConnectorSecretRefBinding,
): string {
  assertUuid(binding.tenant_id, 'tenant_id');
  assertUuid(binding.connection_id, 'connection_id');
  return `${CONNECTOR_SECRET_REF_PREFIX}:${CONNECTOR_SECRET_REF_VERSION}:${binding.tenant_id}:${binding.connection_id}`;
}

/**
 * Parse an opaque secret reference back into its binding. Throws on any
 * malformed / non-connector / non-current-version value — the resolver treats a
 * parse failure as a hard isolation failure (no secret resolution proceeds).
 */
export function parseConnectorSecretRef(ref: string): ParsedConnectorSecretRef {
  const parts = ref.split(':');
  if (parts.length !== 4) {
    throw new Error('malformed connector secret_ref');
  }
  const [prefix, version, tenant_id, connection_id] = parts;
  if (
    prefix === undefined ||
    version === undefined ||
    tenant_id === undefined ||
    connection_id === undefined
  ) {
    throw new Error('malformed connector secret_ref');
  }
  if (prefix !== CONNECTOR_SECRET_REF_PREFIX) {
    throw new Error('not a connector secret_ref');
  }
  if (version !== CONNECTOR_SECRET_REF_VERSION) {
    throw new Error('unsupported connector secret_ref version');
  }
  assertUuid(tenant_id, 'tenant_id');
  assertUuid(connection_id, 'connection_id');
  return { version, tenant_id, connection_id };
}

/**
 * Defensive binding assertion: the stored secret_ref MUST encode the same
 * (tenant_id, connection_id) as the connection being executed. Any mismatch is
 * a hard isolation failure. This is belt-and-suspenders on top of the
 * tenant-first connection lookup.
 */
export function assertConnectorSecretRefBinding(
  ref: string,
  expected: ConnectorSecretRefBinding,
): void {
  const parsed = parseConnectorSecretRef(ref);
  if (
    parsed.tenant_id !== expected.tenant_id ||
    parsed.connection_id !== expected.connection_id
  ) {
    throw new Error('connector secret_ref binding mismatch');
  }
}

/**
 * Derive the AWS Secrets Manager secret id for a connection. SERVER-controlled,
 * env-scoped, tenant-namespaced: `aramo/<env>/connector/<tenant_id>/<connection_id>`.
 * Callers MUST pass the connection's OWN tenant_id/connection_id (loaded
 * tenant-first), NEVER raw client input.
 */
export function deriveConnectorSecretManagerId(args: {
  readonly env: string;
  readonly tenant_id: string;
  readonly connection_id: string;
}): string {
  if (args.env.length === 0) {
    throw new Error('ARAMO_ENV not set');
  }
  assertUuid(args.tenant_id, 'tenant_id');
  assertUuid(args.connection_id, 'connection_id');
  return `aramo/${args.env}/connector/${args.tenant_id}/${args.connection_id}`;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid ${label}: expected uuid`);
  }
}
