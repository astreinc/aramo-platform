import { CONSUMER_TYPES, type ConsumerType } from './auth-context.types.js';

// D-ORG-4 (Lead disposition 2026-10-17, §3.G) — CONSUMER-ISOLATED session cookies.
//
// Before D-ORG every consumer wrote the SAME host-only cookie (`aramo_access_token`),
// so minting a second consumer session on one host (e.g. `org` after `recruiter`)
// silently overwrote the first and the earlier product's `/session` answered 401
// "consumer mismatch". Each consumer now owns its own cookie TRIPLE, suffixed by
// the consumer name:
//
//   aramo_access_token_<consumer>   path '/'      — read by the API guard and /session
//   aramo_refresh_token_<consumer>  path '/auth'  — read by /auth/<consumer>/refresh + logout
//   aramo_pkce_state_<consumer>     path '/auth'  — the login→callback PKCE seal
//
// All attributes (HttpOnly, Secure in production, SameSite lax/strict, max-age)
// are unchanged. Sessions never share a cookie, so switching products neither
// destroys nor reuses another consumer's session; each remains bound to ITS
// consumer (the JWT `consumer_type` claim is still verified against the path /
// header on every read). The LEGACY unsuffixed names are read as a fallback for
// sessions minted before the cut-over and are cleared on every logout.
//
// This module is the single naming authority: libs/auth (the API guard) and
// libs/auth-core (the controllers) both import it, so the names cannot drift.

export const LEGACY_ACCESS_COOKIE = 'aramo_access_token';
export const LEGACY_REFRESH_COOKIE = 'aramo_refresh_token';
export const LEGACY_PKCE_COOKIE = 'aramo_pkce_state';

export const CONSUMER_HEADER = 'x-aramo-consumer';

export function accessCookieName(consumer: ConsumerType): string {
  return `${LEGACY_ACCESS_COOKIE}_${consumer}`;
}
export function refreshCookieName(consumer: ConsumerType): string {
  return `${LEGACY_REFRESH_COOKIE}_${consumer}`;
}
export function pkceCookieName(consumer: ConsumerType): string {
  return `${LEGACY_PKCE_COOKIE}_${consumer}`;
}

// Every access-cookie name a host may carry (one per consumer) — used by the guard's
// header-less fallback and by the global sign-out that clears all of them.
export function allAccessCookieNames(): readonly string[] {
  return CONSUMER_TYPES.map(accessCookieName);
}
export function allRefreshCookieNames(): readonly { consumer: ConsumerType; name: string }[] {
  return CONSUMER_TYPES.map((c) => ({ consumer: c, name: refreshCookieName(c) }));
}

export function isConsumerType(value: string | undefined): value is ConsumerType {
  return value !== undefined && (CONSUMER_TYPES as readonly string[]).includes(value);
}

// Select the access token cookie for a request:
//   1. `X-Aramo-Consumer: <consumer>` (set by every Aramo front end) → that consumer's
//      cookie, falling back to the legacy cookie for sessions minted before the cut-over.
//   2. No header → the legacy cookie if present; else, if EXACTLY ONE consumer cookie
//      is present it is unambiguous and used; two or more → ambiguous → null.
export type CookieSelection =
  | { kind: 'found'; token: string; consumer: ConsumerType | null }
  | { kind: 'absent' }
  | { kind: 'ambiguous'; present: ConsumerType[] }
  | { kind: 'invalid_header'; header: string };

export function selectAccessCookie(
  cookies: Record<string, string | undefined> | undefined,
  consumerHeader: string | undefined,
): CookieSelection {
  const jar = cookies ?? {};
  const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.length > 0;
  if (consumerHeader !== undefined) {
    if (!isConsumerType(consumerHeader)) return { kind: 'invalid_header', header: consumerHeader };
    const own = jar[accessCookieName(consumerHeader)];
    if (nonEmpty(own)) return { kind: 'found', token: own, consumer: consumerHeader };
    const legacy = jar[LEGACY_ACCESS_COOKIE];
    if (nonEmpty(legacy)) return { kind: 'found', token: legacy, consumer: consumerHeader };
    return { kind: 'absent' };
  }
  const legacy = jar[LEGACY_ACCESS_COOKIE];
  if (nonEmpty(legacy)) return { kind: 'found', token: legacy, consumer: null };
  const present = CONSUMER_TYPES.filter((c) => nonEmpty(jar[accessCookieName(c)]));
  if (present.length === 1) {
    const c = present[0]!;
    return { kind: 'found', token: jar[accessCookieName(c)] as string, consumer: c };
  }
  if (present.length > 1) return { kind: 'ambiguous', present: [...present] };
  return { kind: 'absent' };
}
