// Point-in-time activity-window selection (ADR-0024 §D17b
// `effective_from` / `effective_to`).
//
// A version is active at instant `at` when:
//
//     effective_from <= at   AND   (effective_to IS NULL OR at < effective_to)
//
// i.e. the lower bound is INCLUSIVE and the upper bound is EXCLUSIVE. A NULL
// upper bound is an open/current window. The publish path maintains
// non-overlapping windows per (tenant, package), so at most one version
// satisfies the predicate at any instant; if none do (a query before the
// first publication), the result is undefined/null.
//
// This selection is a pure function so its boundary behaviour is unit-tested
// without a database; the store fetches the (tenant, package) versions and
// applies it in one place, avoiding SQL/JS drift.

export interface EffectiveWindow {
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

/** True when `window` is active at `at` (from inclusive, to exclusive). */
export function isEffectiveAt(window: EffectiveWindow, at: Date): boolean {
  const from = window.effective_from.getTime();
  const to = window.effective_to?.getTime();
  const t = at.getTime();
  if (t < from) return false;
  if (to !== undefined && t >= to) return false;
  return true;
}

/**
 * Select the single version active at `at` from the set of versions for one
 * (tenant, package). Returns `undefined` when none is active. If more than
 * one matches (should be impossible given non-overlapping windows), the one
 * with the latest `effective_from` wins — the most recently activated.
 */
export function selectEffectiveAt<T extends EffectiveWindow>(versions: readonly T[], at: Date): T | undefined {
  let best: T | undefined;
  for (const version of versions) {
    if (!isEffectiveAt(version, at)) continue;
    if (best === undefined || version.effective_from.getTime() > best.effective_from.getTime()) {
      best = version;
    }
  }
  return best;
}
