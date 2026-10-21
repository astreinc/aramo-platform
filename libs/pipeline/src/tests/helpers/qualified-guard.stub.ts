import type { QualifiedTransitionGuardPort } from '../../lib/qualified-transition-guard.port.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.5/§4.8 — the RTR guard is
// MANDATORY for `qualified` (an unbound guard refuses the transition). The ONE shared
// stub for hand-wired `new PipelineRepository(prisma, …)` substrate specs that exercise
// the qualified milestone but are not ABOUT RTR: the effective requirement resolves to an
// explicit NOT_REQUIRED (never "ungoverned"). The real guard — lock, linearization, executed-
// RTR FOR SHARE — is proven in apps/api (s1-rtr-policy-integrity.integration.spec.ts).
export const NOT_REQUIRED_QUALIFIED_GUARD: QualifiedTransitionGuardPort = {
  beginQualifyInTx: async () => undefined,
  assertCanQualifyInTx: async () => ({
    disposition: 'NOT_REQUIRED',
    source: 'TENANT_DEFAULT',
    scope_ref: null,
    version: 'test',
    checksum: 'test',
    composite_version: 'TENANT:test:test',
    resolved_at: new Date(0).toISOString(),
  }),
};
