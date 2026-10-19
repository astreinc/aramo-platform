// Sign Unified Product S-2 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.1.3) — ONE base-URL setting for the one
// Aramo Sign host. Every link Aramo Sign builds — signer links (/s/<token>),
// signed-copy links (/d/<token>), sender console links (/sign/…) and billing
// return URLs — starts from this origin.
//
//   ARAMO_SIGN_BASE_URL       the setting (e.g. https://sign.aramo.ai)
//   ESIGN_SIGN_WEB_BASE_URL   honoured as a fallback (pre-S-2 signer origin)
//   ESIGN_SENDER_WEB_BASE_URL honoured as a last fallback (pre-S-2 console origin)
//
// Returns the trimmed origin, or null when none is configured (callers that must
// not send a link without an origin keep that behaviour).
export function signBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ['ARAMO_SIGN_BASE_URL', 'ESIGN_SIGN_WEB_BASE_URL', 'ESIGN_SENDER_WEB_BASE_URL']) {
    const v = env[key]?.trim();
    if (v !== undefined && v !== '') return v.replace(/\/+$/, '');
  }
  return null;
}

// The production default where a link is always needed (billing return URLs).
export const DEFAULT_SIGN_BASE_URL = 'https://sign.aramo.ai';
