// Consolidated Directive v1.0 B2 — the sender's per-recipient options, each shown ONLY
// while GET /v1/sign/sender/context reports it available (`features.<key> === true`).
// The server checks every choice again (launch availability and plan).
//
// Client Rule Consolidation C3 (audit row 15) — the rule lives once in @aramo/sign-client.
export { NO_SEND_FEATURES, messagingOffered, sendFeaturesOf, type SendFeatures } from '@aramo/sign-client';
