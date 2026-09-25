import type { SatisfactionPolicyValue, WaiverModeValue } from './pre-start-requirement-vocab.js';

// PR-1 (CSP directive §D4-A) — FLOOR strictness comparators. A FLOOR requirement may
// only be STRENGTHENED by a more-specific scope, never weakened, on every strictness-
// bearing dimension. Existence is protected structurally by the union-only layered
// merge (a more-specific scope can never remove a broader requirement_type), so it is
// not a comparator here. The strictness-bearing dimensions on a requirement definition
// are exactly: blocking, waiver_mode, satisfaction_policy. (label/sequence are
// presentation; requirement_type/id/set_id/tenant_id are identity; owner_role and
// created_at are metadata — none bear on strictness.)

export interface StrictnessDims {
  readonly blocking: boolean;
  readonly waiver_mode: WaiverModeValue;
  readonly satisfaction_policy: SatisfactionPolicyValue;
}

export type StrictnessDimension = 'blocking' | 'waiver_mode' | 'satisfaction_policy';

// blocking: linear order — true (blocks readiness) is stricter than false.
export function blockingIsAtLeastAsStrictAs(override: boolean, floor: boolean): boolean {
  // floor=false → any override is fine; floor=true → the override must also block.
  return override || !floor;
}

// satisfaction_policy: linear order — VERIFICATION_REQUIRED is stricter than SELF_ATTEST.
export function satisfactionPolicyIsAtLeastAsStrictAs(
  override: SatisfactionPolicyValue,
  floor: SatisfactionPolicyValue,
): boolean {
  if (override === floor) return true;
  return override === 'VERIFICATION_REQUIRED'; // the only value that dominates the other
}

// waiver_mode: PARTIAL order. NOT_WAIVABLE (no authority can ever waive) dominates
// all. The three authority-scoped modes each admit a DIFFERENT single waiver authority
// and are mutually INCOMPARABLE lateral gates — a floor that mandates one authority is
// NOT satisfied by switching to another. Explicit bounded relation (never a numeric
// ranking): an override is at-least-as-strict as a floor iff it is the same mode, or it
// is NOT_WAIVABLE (the sole strengthening every authority-scoped mode admits).
export function waiverModeIsAtLeastAsStrictAs(override: WaiverModeValue, floor: WaiverModeValue): boolean {
  if (override === floor) return true;
  return override === 'NOT_WAIVABLE';
}

// Returns the FIRST strictness dimension on which `override` is less strict than
// `floor`, or null when the override satisfies the floor on every dimension.
export function floorViolation(override: StrictnessDims, floor: StrictnessDims): StrictnessDimension | null {
  if (!blockingIsAtLeastAsStrictAs(override.blocking, floor.blocking)) return 'blocking';
  if (!waiverModeIsAtLeastAsStrictAs(override.waiver_mode, floor.waiver_mode)) return 'waiver_mode';
  if (!satisfactionPolicyIsAtLeastAsStrictAs(override.satisfaction_policy, floor.satisfaction_policy)) {
    return 'satisfaction_policy';
  }
  return null;
}

// Accumulate the STRICTEST floor as the layered chain descends: floor' =
// strictest(floor, override). Only ever called AFTER `override` has satisfied `floor`
// (floorViolation === null), so each dimension's join is over a comparable pair and
// always exists — including waiver_mode, where a satisfying override is either equal to
// the floor or NOT_WAIVABLE.
export function joinFloor(floor: StrictnessDims, override: StrictnessDims): StrictnessDims {
  return {
    blocking: floor.blocking || override.blocking,
    waiver_mode: override.waiver_mode === 'NOT_WAIVABLE' ? 'NOT_WAIVABLE' : floor.waiver_mode,
    satisfaction_policy:
      floor.satisfaction_policy === 'VERIFICATION_REQUIRED' || override.satisfaction_policy === 'VERIFICATION_REQUIRED'
        ? 'VERIFICATION_REQUIRED'
        : 'SELF_ATTEST',
  };
}
