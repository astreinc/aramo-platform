// SRC-1 PR-2 — Indeed Apply webhook constants (shared by main.ts raw-parser
// mount, the controller, and the processing service).

// R6 — mount point. Wildcard tenant host only (audit E3: reachable today with
// zero Caddy change; admin/portal hosts stay walled).
export const INDEED_APPLY_WEBHOOK_ROUTE = '/v1/webhooks/indeed/apply';

// RECON-3c — the route-scoped raw parser's size cap. Indeed apply payloads carry
// a base64 résumé (large), so this ONE route accepts up to 2 MiB of raw bytes —
// well above the default ~100 kB JSON limit that every other route keeps.
export const INDEED_APPLY_MAX_BODY_BYTES = 2 * 1024 * 1024;

// R9 — the partner-provisioned Indeed Apply "api Secret" (HMAC key). Unset →
// the endpoint refuses ALL traffic (503, dark by construction) per R5.
export const INDEED_APPLY_WEBHOOK_SECRET_ENV = 'ARAMO_INDEED_APPLY_WEBHOOK_SECRET';

// The staging dedup-memory channel (uppercase — the sourced_talent
// source_channel value) and the object-storage channel segment (lowercase).
export const INDEED_SOURCE_CHANNEL = 'INDEED';
export const INDEED_STORAGE_CHANNEL = 'indeed';
