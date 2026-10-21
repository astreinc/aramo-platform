// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.2 (S3, A1 AM-3) — a PUT_ON_HOLD PATCH
// must carry its reason + source. The ONE shared fixture for specs that put a requisition on hold
// as setup (CLAUDE.md shared-helper law — the same edit across N specs).
export const TEST_HOLD = { reason: 'Client hiring temporarily paused', source: 'client' } as const;
