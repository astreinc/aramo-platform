// COMM-B6 — Zoom webhook envelope parse. Extracts the routing/dedup/correlation
// facts needed BEFORE canonical normalization: the event type, the (signed)
// account id used for trusted tenant/connection resolution, the call correlation
// ids (call_element → call_history → call_id), an occurred-at, a url_validation
// plainToken, and a STABLE dedup key. Zoom vendor shape is confined here (outside
// the neutrality scan). Real Zoom payload field names are B8-verifiable; this
// targets Zoom's documented Phone-webhook structure and is proven in CI against
// synthetic payloads. NO raw payload is retained by callers — only these facts.

export interface ZoomWebhookEnvelope {
  readonly event: string;
  /** Zoom `event_ts` (unix MILLISECONDS) or null. */
  readonly event_ts: number | null;
  /** payload.account_id — the SIGNED account identity (trusted post-HMAC). */
  readonly account_id: string | null;
  readonly object: {
    readonly call_id: string | null;
    readonly call_history_uuid: string | null;
    readonly call_element_id: string | null;
  };
  /** endpoint.url_validation plainToken, when present. */
  readonly plain_token: string | null;
  /** Stable idempotency key derived from (event, best-correlation-id, event_ts). */
  readonly provider_event_key: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Parse a raw Zoom webhook body. Returns null for malformed JSON or a missing event. */
export function parseZoomWebhookEnvelope(rawBody: string): ZoomWebhookEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const event = str(root['event']);
  if (event === null) return null;

  const payload =
    typeof root['payload'] === 'object' && root['payload'] !== null
      ? (root['payload'] as Record<string, unknown>)
      : {};
  const object =
    typeof payload['object'] === 'object' && payload['object'] !== null
      ? (payload['object'] as Record<string, unknown>)
      : {};

  const call_id = str(object['call_id']);
  // Zoom's call-history identity surfaces as `call_history_id`; the canonical
  // column is `provider_call_history_uuid`.
  const call_history_uuid = str(object['call_history_id']) ?? str(object['call_history_uuid']);
  const call_element_id = str(object['call_element_id']);
  const event_ts = typeof root['event_ts'] === 'number' ? (root['event_ts'] as number) : null;

  const correlation = call_element_id ?? call_history_uuid ?? call_id ?? 'none';
  const provider_event_key = `${event}:${correlation}:${event_ts ?? 0}`;

  return {
    event,
    event_ts,
    account_id: str(payload['account_id']),
    object: { call_id, call_history_uuid, call_element_id },
    plain_token: str(payload['plainToken']),
    provider_event_key,
  };
}
