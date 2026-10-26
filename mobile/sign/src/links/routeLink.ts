// Deep-link routing (M-A2 §3.3; directive §9 "Deep-link safety"). Strict scheme, host
// and path matching; the function is pure and never logs or stores its input.
//
//   https://sign.aramo.ai/s/{token}            -> guest signer (sign)
//   https://sign.aramo.ai/d/{token}            -> guest signer (signed copy)
//   https://sign.aramo.ai/auth/native/callback -> native auth callback
//   aramosign://auth/callback                  -> native auth callback (fallback, M-A1 §3.1)
//   aramosign://envelope/{uuid}                -> envelope detail   (handoff §2; needs sign-in)
//   aramosign://sign/{uuid}                    -> inbox signing     (handoff §2; needs sign-in)
//   any other https://sign.aramo.ai/...        -> open in the browser
//   anything else (foreign host, other scheme, userinfo, port, bad token) -> ignored
import { NATIVE_FALLBACK_REDIRECT_URI, NATIVE_REDIRECT_URI, SIGN_HOST } from '../config/env';

export type LinkRoute =
  | { readonly kind: 'guest'; readonly mode: 'sign' | 'download'; readonly token: string }
  | { readonly kind: 'auth-callback'; readonly url: string }
  | { readonly kind: 'envelope'; readonly envelopeId: string }
  | { readonly kind: 'inbox-sign'; readonly envelopeId: string }
  | { readonly kind: 'browser'; readonly url: string }
  | { readonly kind: 'ignore' };

const IGNORE: LinkRoute = { kind: 'ignore' };

/** Capability tokens are base64url (32 random bytes => 43 chars); allow some headroom. */
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// scheme://authority/path?query#fragment — authority without userinfo or port.
const URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;

export function routeLink(raw: string): LinkRoute {
  if (typeof raw !== 'string' || raw.length > 4096) return IGNORE;
  const m = URL_SHAPE.exec(raw.trim());
  if (!m) return IGNORE;
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  const path = m[3] ?? '';

  if (scheme === 'https') {
    if (authority.toLowerCase() !== SIGN_HOST) return IGNORE; // foreign host, port, userinfo
    if (path === '/auth/native/callback') {
      return { kind: 'auth-callback', url: `${NATIVE_REDIRECT_URI}${m[4] ?? ''}` };
    }
    const g = /^\/(s|d)\/([^/]+)\/?$/.exec(path);
    if (g) {
      const token = g[2] ?? '';
      if (!TOKEN.test(token)) return IGNORE;
      return { kind: 'guest', mode: g[1] === 's' ? 'sign' : 'download', token };
    }
    if (/^\/(s|d)(\/|$)/.test(path)) return IGNORE; // malformed signing link: never forward it
    return { kind: 'browser', url: `https://${SIGN_HOST}${path || '/'}${m[4] ?? ''}` };
  }

  if (scheme === 'aramosign') {
    const host = authority.toLowerCase();
    if (host === 'auth' && path === '/callback') {
      return { kind: 'auth-callback', url: `${NATIVE_FALLBACK_REDIRECT_URI}${m[4] ?? ''}` };
    }
    const id = /^\/([^/]+)\/?$/.exec(path)?.[1] ?? '';
    if (host === 'envelope' && UUID.test(id))
      return { kind: 'envelope', envelopeId: id.toLowerCase() };
    if (host === 'sign' && UUID.test(id))
      return { kind: 'inbox-sign', envelopeId: id.toLowerCase() };
  }
  return IGNORE;
}

/** Routes that need a signed-in user; others work signed out (guest signing). */
export function requiresSession(route: LinkRoute): boolean {
  return route.kind === 'envelope' || route.kind === 'inbox-sign';
}
