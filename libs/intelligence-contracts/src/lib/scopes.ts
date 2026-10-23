import { INTELLIGENCE_INGEST_SCOPE } from './ingest.js';

// ATI-SEP-1 T4–T6 — service-token scopes. A ServiceClient's allowed_scopes is a
// subset of these. Each TI route requires exactly one of them.

/** GET /v1/references/... (profile, evidence, artifacts). */
export const INTELLIGENCE_READ_SCOPE = 'intelligence:read' as const;
/** POST /v1/verifications, POST /v1/verifications/:id/confirm, and the verification-status reads (T10 M-1, M-6). */
export const INTELLIGENCE_VERIFY_SCOPE = 'intelligence:verify' as const;
/** POST /v1/entitlements/sync. */
export const INTELLIGENCE_ENTITLEMENTS_SCOPE = 'intelligence:entitlements' as const;
/** T10 (A3 T10-2) — talent-raised disputes: the portal side and the tenant worklist + disposition. */
export const INTELLIGENCE_DISPUTES_SCOPE = 'intelligence:disputes' as const;
/** T10 (A3 T10-2) — the trust-proposal worklist and contradiction resolution. */
export const INTELLIGENCE_PROPOSALS_SCOPE = 'intelligence:proposals' as const;

export const INTELLIGENCE_SCOPES = [
  INTELLIGENCE_INGEST_SCOPE,
  INTELLIGENCE_READ_SCOPE,
  INTELLIGENCE_VERIFY_SCOPE,
  INTELLIGENCE_ENTITLEMENTS_SCOPE,
  INTELLIGENCE_DISPUTES_SCOPE,
  INTELLIGENCE_PROPOSALS_SCOPE,
] as const;
export type IntelligenceScope = (typeof INTELLIGENCE_SCOPES)[number];

export function isIntelligenceScope(value: unknown): value is IntelligenceScope {
  return typeof value === 'string' && (INTELLIGENCE_SCOPES as readonly string[]).includes(value);
}
