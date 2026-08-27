import { createHash } from 'node:crypto';

import type {
  ExternalRequisitionLifecycleObservation,
  LifecycleFetchContext,
  LifecycleFetchResult,
  LifecycleSourceAdapter,
} from '../../lifecycle-source-adapter.port.js';

import {
  decodeFieldglassCredential,
  type FieldglassCredentialBundle,
} from './fieldglass-credential.js';

// CB-D2-FG (ADR-0030) — the SAP Fieldglass PULL/delta STATE-OBSERVATION lifecycle
// adapter. The FIRST real provider lifecycle source. It lives under
// provider/fieldglass/ (scope:ats), EXCLUDED from the provider-neutrality scan by
// the provider/<name>/ convention, so SAP/Fieldglass vocabulary is legal here.
//
// R-STATE-OBSERVATION: Fieldglass v1 is a STATE-observation connector, NOT an
// event connector. Every emitted change is an `ExternalRequisitionLifecycle
// Observation` (`kind:'observation'`) whose type ENFORCES provider_event_at:null,
// provider_sequence:null, ordering_confidence:'unknown'. The adapter NEVER
// fabricates an event id / timestamp / sequence SAP's public contract does not
// provide; business dates (ValidFrom/ValidTo) are IGNORED for ordering.
//
// R-STATUS-AGNOSTIC: the adapter extracts SAP's raw <Status> string and passes it
// through as `observed_status` VERBATIM. There is NO status->action literal map
// here — mapping is per-connection runtime admin config (upsertMapping), keyed on
// the normalized status downstream. (This is also why no banned FG pre-open status
// literal is ever written in this file.)
//
// R-CREDENTIAL: the adapter NEVER touches Secrets Manager / secret_ref. The
// PRODUCER resolves the tenant-bound secret and hands `ctx.credential` an already-
// resolved ephemeral string; the adapter only decodes its provider-specific
// bundle. A null credential is refused BEFORE any provider call.
//
// HTTP: native global `fetch` only (no shared client / axios); the adapter owns
// its two calls (OAuth token POST + Buyer Job Posting delta GET).

/** The extensible provider key (never a frozen vendor enum). */
export const FIELDGLASS_PROVIDER_KEY = 'fieldglass';

const OAUTH_GRANT_TYPE = 'client_credentials';
// Path fragments appended to the connection's non-secret `base_url`. Kept as
// documented constants so the endpoint shape is auditable in one place.
const OAUTH_TOKEN_PATH = '/api/oauth/token';
const CONNECTOR_PATH_PREFIX = '/api/vc/connector/';
// The "since last download" watermark is passed as a query parameter on the delta
// download GET. SAP's server-side watermark-advance timing is NOT PROVEN (A0);
// the producer advances IntegrationConnection.cursor only AFTER durable ingress,
// so a crash-before-persist re-fetches from the same watermark (the ledger dedups).
const WATERMARK_QUERY_PARAM = 'since';

/** The non-secret endpoint config read from IntegrationConnection.config. */
interface FieldglassConnectionConfig {
  readonly baseUrl: string;
  readonly connectorName: string;
}

/** A raw connector download body + its transport content type. */
interface DeltaDownload {
  readonly body: string;
  readonly contentType: string;
}

/** A single parsed OAGIS StaffingOrder record: the two fields v1 consumes. */
interface ParsedStaffingOrder {
  readonly idValue: string;
  readonly status: string;
}

/** Refusal raised when the producer injected no resolved credential (null). */
export class FieldglassCredentialUnavailableError extends Error {
  constructor() {
    super('CONNECTOR_SECRET_UNAVAILABLE: fieldglass connection has no resolved credential');
    this.name = 'FieldglassCredentialUnavailableError';
  }
}

/** Raised when the non-secret connection config is missing a required field. */
export class FieldglassConfigError extends Error {
  constructor(detail: string) {
    super(`fieldglass connection config invalid: ${detail}`);
    this.name = 'FieldglassConfigError';
  }
}

export class FieldglassLifecycleSource implements LifecycleSourceAdapter {
  readonly providerKey = FIELDGLASS_PROVIDER_KEY;

  async fetchLifecycleChanges(ctx: LifecycleFetchContext): Promise<LifecycleFetchResult> {
    // 1. Refuse a missing credential BEFORE any provider call (R-CREDENTIAL).
    if (ctx.credential === null) {
      throw new FieldglassCredentialUnavailableError();
    }
    const bundle = decodeFieldglassCredential(ctx.credential);
    // 2. Read the NON-SECRET endpoint config (never the secret bundle).
    const config = readConnectionConfig(ctx.config);

    // 3. OAuth2 client-credentials token (native fetch).
    const accessToken = await this.fetchAccessToken(config, bundle);

    // 4. GET the Buyer Job Posting delta download connector using the cursor as the
    //    "since last download" watermark.
    const download = await this.downloadDelta(config, bundle, accessToken, ctx.cursor);

    // 5. Parse the documented OAGIS StaffingOrder output (XML and/or JSON).
    const { downloadId, orders } = parseStaffingOrderDelta(download.body, download.contentType);

    // 6. Emit provider-neutral STATE observations (raw status passthrough; nulls).
    const observedAt = new Date().toISOString();
    const changes = orders.map((order) => toObservation(order, observedAt));

    // The delivery_id is the durable identity of ONE fetch (A0-R5): the connector's
    // own download id when present, else a deterministic hash of the raw body so a
    // redelivery of the SAME delta collides while the next poll is a new delivery.
    const deliveryId = downloadId ?? `fg:${sha256(download.body)}`;
    return {
      delivery: { delivery_id: deliveryId, received_at: observedAt },
      changes,
      // The opaque advanced watermark (persisted by the producer only post-success).
      next_cursor: deliveryId,
    };
  }

  private async fetchAccessToken(
    config: FieldglassConnectionConfig,
    bundle: FieldglassCredentialBundle,
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: OAUTH_GRANT_TYPE,
      client_id: bundle.client_id,
      client_secret: bundle.client_secret,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (bundle.application_key !== undefined) {
      headers['apikey'] = bundle.application_key;
    }
    const res = await fetch(`${config.baseUrl}${OAUTH_TOKEN_PATH}`, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`fieldglass token request failed: ${res.status} ${await safeText(res)}`);
    }
    const json = (await res.json()) as { access_token?: unknown };
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (token.length === 0) {
      throw new Error('fieldglass token response missing access_token');
    }
    return token;
  }

  private async downloadDelta(
    config: FieldglassConnectionConfig,
    bundle: FieldglassCredentialBundle,
    accessToken: string,
    cursor: string | null,
  ): Promise<DeltaDownload> {
    const url = new URL(`${config.baseUrl}${CONNECTOR_PATH_PREFIX}${config.connectorName}`);
    if (cursor !== null && cursor.length > 0) {
      url.searchParams.set(WATERMARK_QUERY_PARAM, cursor);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json, application/xml',
    };
    if (bundle.application_key !== undefined) {
      headers['apikey'] = bundle.application_key;
    }
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`fieldglass delta download failed: ${res.status} ${await safeText(res)}`);
    }
    const body = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    return { body, contentType };
  }
}

/** Build the STATE observation for one staffing order (raw status passthrough). */
function toObservation(
  order: ParsedStaffingOrder,
  observedAt: string,
): ExternalRequisitionLifecycleObservation {
  return {
    kind: 'observation',
    external_req_id: order.idValue,
    observed_status: order.status,
    observed_at: observedAt,
    provider_event_at: null,
    provider_sequence: null,
    ordering_confidence: 'unknown',
  };
}

/** Read + validate the non-secret endpoint config from IntegrationConnection.config. */
function readConnectionConfig(config: Record<string, unknown> | null): FieldglassConnectionConfig {
  if (config === null) {
    throw new FieldglassConfigError('no connection config');
  }
  const baseUrl = typeof config['base_url'] === 'string' ? config['base_url'].replace(/\/+$/, '') : '';
  const connectorName = typeof config['connector_name'] === 'string' ? config['connector_name'] : '';
  if (baseUrl.length === 0) {
    throw new FieldglassConfigError('missing base_url');
  }
  if (connectorName.length === 0) {
    throw new FieldglassConfigError('missing connector_name');
  }
  return { baseUrl, connectorName };
}

// -----------------------------------------------------------------------------
// Parsing the documented OAGIS StaffingOrder delta output. SAP's connector emits
// XML by default; a connection may configure JSON output — both are supported.
// Only two fields are consumed: IdValue -> external_req_id, raw <Status> ->
// observed_status. Business dates (ValidFrom/ValidTo) are deliberately ignored.
// -----------------------------------------------------------------------------
export function parseStaffingOrderDelta(
  body: string,
  contentType: string,
): { downloadId: string | null; orders: ParsedStaffingOrder[] } {
  const trimmed = body.trimStart();
  const looksXml = contentType.toLowerCase().includes('xml') || trimmed.startsWith('<');
  return looksXml ? parseXmlDelta(body) : parseJsonDelta(body);
}

function parseXmlDelta(body: string): { downloadId: string | null; orders: ParsedStaffingOrder[] } {
  const downloadId = firstGroup(body, /<DownloadId>([^<]*)<\/DownloadId>/i);
  const orders: ParsedStaffingOrder[] = [];
  const recordRe = /<StaffingOrder\b[^>]*>([\s\S]*?)<\/StaffingOrder>/gi;
  let match: RegExpExecArray | null;
  while ((match = recordRe.exec(body)) !== null) {
    const record = match[1] ?? '';
    const idValue = firstGroup(record, /<IdValue>([^<]*)<\/IdValue>/i);
    const status = firstGroup(record, /<Status>([^<]*)<\/Status>/i);
    if (idValue !== null && status !== null) {
      orders.push({ idValue: idValue.trim(), status: status.trim() });
    }
  }
  return { downloadId, orders };
}

function parseJsonDelta(body: string): { downloadId: string | null; orders: ParsedStaffingOrder[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('fieldglass delta download is neither valid XML nor JSON');
  }
  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const downloadId = typeof root['DownloadId'] === 'string' ? root['DownloadId'] : null;
  const rawOrders = root['StaffingOrder'] ?? root['staffingOrders'] ?? root['orders'];
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  const orders: ParsedStaffingOrder[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const order = entry as Record<string, unknown>;
    const idValue = extractIdValue(order);
    const status = typeof order['Status'] === 'string' ? order['Status'] : null;
    if (idValue !== null && status !== null) {
      orders.push({ idValue: idValue.trim(), status: status.trim() });
    }
  }
  return { downloadId, orders };
}

// The IdValue nests inside the OAGIS DocumentID/ID envelope; accept the documented
// path and the flatter shapes a connection may configure.
function extractIdValue(order: Record<string, unknown>): string | null {
  const documentId = asObject(order['DocumentID']);
  const nestedId = documentId === null ? null : asObject(documentId['ID']);
  const idPaths: unknown[] = [
    nestedId?.['IdValue'],
    documentId?.['IdValue'],
    asObject(order['ID'])?.['IdValue'],
    order['IdValue'],
  ];
  for (const value of idPaths) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstGroup(source: string, re: RegExp): string | null {
  const m = re.exec(source);
  return m?.[1] ?? null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}
