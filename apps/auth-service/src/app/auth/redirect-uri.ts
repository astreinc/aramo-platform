import type { ConsumerType } from '@aramo/auth';

// Increment-1 Amendment v1.2 (Workstream D) — per-consumer redirect_uri
// derivation. REDIRECT CONSTRUCTION ONLY (D3 scope guard): the consumer-compare,
// PKCE mechanics, cookie attributes (SameSite=Lax stands), verifier, reconcile
// spine, and link guard are untouched.
//
// The single shared AUTH_COGNITO_REDIRECT_URI hardwired ONE consumer's callback
// path independently of the login-time consumer, which produced three
// consecutive acceptance failures (consumer_mismatch ×2 mechanisms +
// pkce_state_missing via the host divergence it invited). Here the callback
// path's consumer segment is DERIVED from the same consumer that is (a) parsed
// from the login path and sealed into the PKCE state cookie at authorize, and
// (b) re-validated at callback before token exchange. Login-time and
// callback-time consumers can no longer diverge by construction, and OAuth's
// "exchange redirect_uri == authorize redirect_uri" holds because both derive
// from the same consumer + same base.
//
// Base URL resolution (D2):
//   1. AUTH_PUBLIC_BASE_URL — the new canonical env (local: http://localhost:4201).
//   2. Deprecation fallback — the ORIGIN of the legacy AUTH_COGNITO_REDIRECT_URI
//      when AUTH_PUBLIC_BASE_URL is unset. Clean removal ripples beyond the auth
//      surface (deploy compose files, tfvars examples, 5 specs, the pact
//      verifier), so the legacy var is retained as a fallback per the amendment.
//   3. null when neither is set — the caller preserves its existing
//      throw-if-missing posture (cognito_env_missing / exchange-env-missing).

function resolvePublicBaseUrl(): string | null {
  const explicit = process.env['AUTH_PUBLIC_BASE_URL'];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.replace(/\/+$/, '');
  }
  // Deprecation fallback: derive the origin (scheme + host + port) of the legacy
  // full-callback env. e.g. https://astre.aramo.ai/auth/recruiter/callback →
  // https://astre.aramo.ai — which then re-derives per consumer below.
  const legacy = process.env['AUTH_COGNITO_REDIRECT_URI'];
  if (legacy !== undefined && legacy.length > 0) {
    try {
      return new URL(legacy).origin;
    } catch {
      return null;
    }
  }
  return null;
}

// Build the callback URL for a specific consumer: `${base}/auth/${consumer}/callback`.
// Returns null only when no base env is configured (caller throws).
export function deriveRedirectUri(consumer: ConsumerType): string | null {
  const base = resolvePublicBaseUrl();
  if (base === null) return null;
  return `${base}/auth/${consumer}/callback`;
}
