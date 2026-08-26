// COMM-B6 — Zoom webhook ingress constants (shared by the main.ts raw-parser
// mount, the controller, and the processing service).

// Provider ingress lives in the established webhook namespace (NOT a normal
// authenticated Communications resource).
export const ZOOM_WEBHOOK_ROUTE = '/v1/webhooks/communications/zoom';

// Zoom phone webhook payloads are small control events (no résumé/media) — a
// tight raw-body cap; well under the default JSON limit other routes keep.
export const ZOOM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export const ZOOM_WEBHOOK_TIMESTAMP_HEADER = 'x-zm-request-timestamp';
export const ZOOM_WEBHOOK_SIGNATURE_HEADER = 'x-zm-signature';

// Replay window (seconds) around x-zm-request-timestamp — a correctly signed but
// stale captured request must not remain indefinitely replayable.
export const ZOOM_WEBHOOK_TOLERANCE_SEC = 300;

// The locked provider key (composition root; not in the neutral domain).
export const ZOOM_WEBHOOK_PROVIDER_KEY = 'zoom_phone';
