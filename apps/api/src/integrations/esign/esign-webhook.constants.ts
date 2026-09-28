// E-Sign OC v2 — Core consumer-owned webhook receiver constants. The canonical
// E-Sign -> Core lifecycle-event contract (Independent-Digital-Signature-Platform
// Directive sections 9, 12, 13B). The raw request bytes must survive to the HMAC
// verifier, so main.ts mounts a route-scoped express.raw parser at this exact path.
export const ESIGN_EVENTS_WEBHOOK_ROUTE = '/v1/integrations/esign/events';

// Events carry ids only (no bytes/PII), so the body is small.
export const ESIGN_EVENTS_MAX_BODY_BYTES = 64 * 1024;

// Replay-protection window: reject a signed request whose timestamp is more than
// this many seconds from now (in either direction).
export const ESIGN_WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

export const ESIGN_WEBHOOK_TIMESTAMP_HEADER = 'x-aramo-esign-timestamp';
export const ESIGN_WEBHOOK_SIGNATURE_HEADER = 'x-aramo-esign-signature';
