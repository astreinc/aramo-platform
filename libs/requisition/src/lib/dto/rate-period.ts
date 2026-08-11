// Track 5 Amendment A2 — the canonical RatePeriod authority moved to libs/common
// (the single backend home; consumed by requisition + placement without a
// placement->requisition edge). This is a thin compatibility re-export ONLY —
// ZERO duplicated list/validation logic. Existing requisition consumers keep
// importing from this path unchanged.
export { RATE_PERIOD_VALUES, isRatePeriod, type RatePeriod } from '@aramo/common';
