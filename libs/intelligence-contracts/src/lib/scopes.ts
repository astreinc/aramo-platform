import { INTELLIGENCE_INGEST_SCOPE } from './ingest.js';

// ATI-SEP-1 T4–T6 — service-token scopes. A ServiceClient's allowed_scopes is a
// subset of these. Each TI route requires exactly one of them.

/** GET /v1/references/... (profile, evidence, artifacts). */
export const INTELLIGENCE_READ_SCOPE = 'intelligence:read' as const;
/** POST /v1/verifications and POST /v1/verifications/:id/confirm. */
export const INTELLIGENCE_VERIFY_SCOPE = 'intelligence:verify' as const;
/** POST /v1/entitlements/sync. */
export const INTELLIGENCE_ENTITLEMENTS_SCOPE = 'intelligence:entitlements' as const;

export const INTELLIGENCE_SCOPES = [
  INTELLIGENCE_INGEST_SCOPE,
  INTELLIGENCE_READ_SCOPE,
  INTELLIGENCE_VERIFY_SCOPE,
  INTELLIGENCE_ENTITLEMENTS_SCOPE,
] as const;
export type IntelligenceScope = (typeof INTELLIGENCE_SCOPES)[number];

export function isIntelligenceScope(value: unknown): value is IntelligenceScope {
  return typeof value === 'string' && (INTELLIGENCE_SCOPES as readonly string[]).includes(value);
}
