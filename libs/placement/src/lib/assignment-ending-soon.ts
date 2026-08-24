// Slice #3 (LOCKED Aramo-Assignment-Extension v1.0, R-ENDING-SOON). "Ending soon"
// is a DERIVED read condition — NEVER a stored lifecycle state or column. The
// horizon is a v1 PRODUCT DEFAULT (SAP examples use 14d, workforce programs vary),
// NOT a domain invariant — defined ONCE here so it is never scattered across
// SQL/TS/UI. A future TenantAssignmentPolicy.ending_soon_days MAY override it
// (deferred — no config surface today). Absolute-UTC math (no tenant timezone).
export const DEFAULT_ASSIGNMENT_ENDING_SOON_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ACTIVE assignment whose planned end is in the future AND within the horizon.
// ENDED, null-horizon, and already-past assignments are never "ending soon".
export function isAssignmentEndingSoon(args: {
  readonly lifecycle_state: 'ACTIVE' | 'ENDED' | null;
  readonly expected_end_at: Date | null;
  readonly now?: Date;
  readonly horizon_days?: number;
}): boolean {
  if (args.lifecycle_state !== 'ACTIVE') return false;
  if (args.expected_end_at === null) return false;
  const now = (args.now ?? new Date()).getTime();
  const horizonDays = args.horizon_days ?? DEFAULT_ASSIGNMENT_ENDING_SOON_DAYS;
  const end = args.expected_end_at.getTime();
  return end > now && end <= now + horizonDays * MS_PER_DAY;
}
