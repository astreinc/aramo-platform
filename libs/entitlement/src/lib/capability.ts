// PR-A1b Ruling 2 — capability catalog named to suite surfaces.
//
// `sourcing` is reserved at PR-A1b; runtime enforcement deferred to Phase B
// per Ruling 3. Names are locked-vocabulary-clean (Rule 5).
export const CAPABILITY_VALUES = ['core', 'ats', 'portal', 'sourcing'] as const;
export type Capability = (typeof CAPABILITY_VALUES)[number];

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === 'string' &&
    (CAPABILITY_VALUES as readonly string[]).includes(value)
  );
}
