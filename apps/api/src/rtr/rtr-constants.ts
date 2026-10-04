// RTR-TEMPLATE-1 — shared RTR constants for the apps/api RTR composition.
//
// The seeded SYSTEM RIGHT_TO_REPRESENT DocumentType id (R-5-2, fixed UUID). This
// is the single apps/api source consumed by the resolver; rtr-orchestrator.service
// and document-readiness.gate currently carry their own copies and converge onto
// this module in RTR-T2 when the orchestrator is rewired. The platform-admin
// provisioning seam deliberately re-declares the same literal as a hand-sync
// boundary (verified by a drift test), never importing scope:ats from scope:platform.
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';
export const RIGHT_TO_REPRESENT_KEY = 'RIGHT_TO_REPRESENT';
