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

// T2-E1-HF2 — the canonical default tenant capability bundle. This is the SINGLE
// authoritative source of the "what capabilities does a normal tenant get"
// answer: the platform provisioning saga and the entitlement reconciliation
// entrypoint both import THIS constant. `sourcing` is deliberately excluded
// (reserved at PR-A1b, Phase B). Do not maintain a second hand-typed copy.
export const DEFAULT_TENANT_CAPABILITIES: readonly Capability[] = [
  'core',
  'ats',
  'portal',
];
