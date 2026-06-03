// PR-A8-1 — engine config (the threshold + revert window).
//
// [GATE-5 PREMISE]: A8-1 substrate has NO per-tenant config table
// (libs/common / libs/identity / libs/entitlement carry NO settings or
// tenant_settings model — grep confirms). Introducing one to satisfy
// "configurable threshold" would balloon scope.
//
// The chosen mechanism (proposed for Lead review): env-driven defaults
// with code-level constants. The threshold is read from env at
// engine-construction time (NOT per-request) so a tenant's "different
// threshold" today is operationally achieved by per-deployment env, not
// per-tenant config. A future PR (A8-1b or tenant-settings) can
// introduce a `tenant_settings` row and override these defaults
// per-tenant without touching the engine's surface.
//
// THE explicit anti-pattern we are NOT replicating: OpenCATS's
// hard-coded `100` failure threshold (frozen at compile-time). The
// directive §0 calls this out as the thing we are fixing.

export interface ImportEngineConfig {
  // Percentage (0–100) of rows that may fail before the WHOLE batch is
  // rejected. A row count of R and a threshold of T% means: if
  // failure_count > floor(R * T / 100), the batch rejects.
  //
  // Default: 10 (10%). A 100-row CSV tolerates up to 10 row failures;
  // an 11th failure rejects the batch.
  failure_threshold_pct: number;

  // Days within which a committed/partially_committed batch can be
  // reverted. Default: 7 days. Past this window, POST /v1/imports/:id/
  // revert refuses with IMPORT_REVERT_WINDOW_EXPIRED.
  revert_window_days: number;
}

const DEFAULT_FAILURE_THRESHOLD_PCT = 10;
const DEFAULT_REVERT_WINDOW_DAYS = 7;

// Parse a non-negative integer from env; on absent/garbage, return the
// default. Bounded by [0, max] (so threshold > 100% or window > 365 days
// can't accidentally land).
function readBoundedInt(
  envKey: string,
  defaultValue: number,
  max: number,
): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.length === 0) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return Math.min(parsed, max);
}

export function loadImportEngineConfig(): ImportEngineConfig {
  return {
    failure_threshold_pct: readBoundedInt(
      'IMPORT_FAILURE_THRESHOLD_PCT',
      DEFAULT_FAILURE_THRESHOLD_PCT,
      100,
    ),
    revert_window_days: readBoundedInt(
      'IMPORT_REVERT_WINDOW_DAYS',
      DEFAULT_REVERT_WINDOW_DAYS,
      365,
    ),
  };
}

// Pure threshold check, exported for the spec.
//   row_count = 100, failure_count = 10, threshold = 10 → false (at limit, allowed).
//   row_count = 100, failure_count = 11, threshold = 10 → true (rejects).
//   row_count = 0   → false (empty batch never rejects; degenerate input).
export function thresholdExceeded(
  row_count: number,
  failure_count: number,
  threshold_pct: number,
): boolean {
  if (row_count === 0) return false;
  const limit = Math.floor((row_count * threshold_pct) / 100);
  return failure_count > limit;
}
