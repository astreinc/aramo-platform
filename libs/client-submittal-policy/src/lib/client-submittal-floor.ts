import type { ClientSubmittalRequirement, Disposition, OverrideClass } from './client-submittal-vocab.js';

// CSP PR-2 (§D4-A, submittal domain) — FLOOR strictness. A more-specific scope may
// only STRENGTHEN a FLOOR requirement, never weaken it, across the two strictness-
// bearing dimensions (both LINEAR):
//   - disposition:    REQUIRED  is stricter than NOT_REQUIRED
//   - override_class: HARD_DENY is stricter than OVERRIDABLE is stricter than AUDIT_ONLY
// The override_class ordering is used ONLY for this FLOOR comparison; the runtime
// outcome comes from the compiler's fixed mapping, never from this ordering.

export function dispositionIsAtLeastAsStrictAs(override: Disposition, floor: Disposition): boolean {
  return override === floor || override === 'REQUIRED';
}

// Strictness levels used ONLY for the FLOOR relation below (never a runtime semantic).
const OVERRIDE_CLASS_STRICTNESS: Readonly<Record<OverrideClass, number>> = {
  HARD_DENY: 2,
  OVERRIDABLE: 1,
  AUDIT_ONLY: 0,
};
export function overrideClassIsAtLeastAsStrictAs(override: OverrideClass, floor: OverrideClass): boolean {
  return OVERRIDE_CLASS_STRICTNESS[override] >= OVERRIDE_CLASS_STRICTNESS[floor];
}

export type SubmittalFloorDimension = 'disposition' | 'override_class';

// The FIRST strictness dimension on which `override` is less strict than `floor`,
// or null when the override satisfies the floor on every dimension.
export function floorViolation(
  override: ClientSubmittalRequirement,
  floor: ClientSubmittalRequirement,
): SubmittalFloorDimension | null {
  if (!dispositionIsAtLeastAsStrictAs(override.disposition, floor.disposition)) return 'disposition';
  if (!overrideClassIsAtLeastAsStrictAs(override.override_class, floor.override_class)) return 'override_class';
  return null;
}

// Accumulate the STRICTEST floor down-scope (only called AFTER `override` satisfies
// `floor`, so each dimension's join exists). Keeps the requirement FLOOR-protected.
export function joinFloor(
  floor: ClientSubmittalRequirement,
  override: ClientSubmittalRequirement,
): ClientSubmittalRequirement {
  return {
    key: floor.key,
    disposition: floor.disposition === 'REQUIRED' || override.disposition === 'REQUIRED' ? 'REQUIRED' : 'NOT_REQUIRED',
    override_class:
      OVERRIDE_CLASS_STRICTNESS[override.override_class] >= OVERRIDE_CLASS_STRICTNESS[floor.override_class]
        ? override.override_class
        : floor.override_class,
    override_policy: 'FLOOR',
  };
}
