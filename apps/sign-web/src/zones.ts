// Sign Unified Product S-2 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.1.3) — the three authentication zones of
// the one Aramo Sign application on sign.aramo.ai:
//
//   guest      /s/:token (sign) and /d/:token (signed copy) — capability token
//              only. No session fetch, no workspace code, no sign-in redirect;
//              never reaches a workspace API.
//   workspace  everything else — Aramo single sign-on (auth consumer `sign`),
//              including the public entry pages (/login, /signed-out, /signup).
//
// A legacy signing link carrying ?token= at the root is still a guest link.

export type Zone = 'guest-sign' | 'guest-download' | 'workspace';

export function zoneFor(pathname: string, search: string): Zone {
  if (pathname.startsWith('/d/')) return 'guest-download';
  if (pathname.startsWith('/s/')) return 'guest-sign';
  if ((pathname === '/' || pathname === '') && new URLSearchParams(search).has('token')) return 'guest-sign';
  return 'workspace';
}
