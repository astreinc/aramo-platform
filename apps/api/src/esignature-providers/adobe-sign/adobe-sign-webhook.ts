// Adobe Acrobat Sign webhooks carry no payload signature: Adobe proves intent by
// sending our application client id in X-AdobeSign-ClientId, and expects it echoed
// (header or { xAdobeSignClientId }) on success. That is NOT a cryptographic
// guarantee, so the payload is only a hint: the agreement must be one this platform
// routed, and its completion is confirmed with the tenant's own Adobe token.

export const ADOBE_SIGN_EVIDENCE_KIND = 'ADOBE_SIGN_AUDIT_REPORT';
export const ADOBE_SIGN_CLIENT_ID_HEADER = 'x-adobesign-clientid';

/**
 * The OAuth callback tells us which regional API host serves the account. Only
 * Adobe Sign hosts over HTTPS are trusted, so a tampered callback cannot route the
 * authorization code, client secret or tokens to another server.
 */
export function isAdobeSignHost(apiAccessPoint: string): boolean {
  let u: URL;
  try {
    u = new URL(apiAccessPoint);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && (u.hostname === 'adobesign.com' || u.hostname.endsWith('.adobesign.com') || u.hostname.endsWith('.adobesign.us'));
}
