// Track 5 Amendment A2 — the canonical ISO-4217 validator moved to libs/common
// (the single backend home; consumed by requisition + placement without a
// placement->requisition edge). This is a thin compatibility re-export ONLY —
// ZERO duplicated list/validation logic. Existing requisition consumers keep
// importing from this path unchanged.
export { isIso4217Currency } from '@aramo/common';
