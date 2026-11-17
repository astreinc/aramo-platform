// Sign Unified Product S-2 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.1.3) — the three authentication zones of
// the one Aramo Sign application on sign.aramo.ai:
//
//   guest      /s/:token (sign), /qes/callback (QES return), /d/:token (signed copy) and
//              /c/:token (a copy recipient's "For your records" view, M-A5 §2.2) — capability token
//              only. No session fetch, no workspace code, no sign-in redirect;
//              never reaches a workspace API.
//   workspace  everything else — Aramo single sign-on (auth consumer `sign`),
//              including the public entry pages (/login, /signed-out, /signup).
//
// A legacy signing link carrying ?token= at the root is still a guest link.

export type Zone = 'guest-sign' | 'guest-download' | 'guest-copy' | 'workspace';

export function zoneFor(pathname: string, search: string): Zone {
  if (pathname.startsWith('/d/')) return 'guest-download';
  // UAT CMP-14 — the RECIPIENT_COPY email links to /c/:token; without this it fell into
  // the workspace and asked the copy recipient to sign in.
  if (pathname.startsWith('/c/')) return 'guest-copy';
  if (pathname.startsWith('/s/')) return 'guest-sign';
  // Consolidated Directive B3 — the QES return page registered at the trust service provider
  // (regulated-signing.service.ts QES_CALLBACK_PATH): a guest page, token from this tab only.
  if (pathname === '/qes/callback') return 'guest-sign';
  if ((pathname === '/' || pathname === '') && new URLSearchParams(search).has('token')) return 'guest-sign';
  return 'workspace';
}
