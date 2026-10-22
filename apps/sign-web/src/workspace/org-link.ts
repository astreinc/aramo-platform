import { ssoEntryHref } from '@aramo/fe-foundation';

// ORG-UX-1 (Directive v1.0 LOCKED §6/§7.2, H6, Lead Correction C) — a link from Aramo Sign
// to an Organization page on the tenant host. It goes through the org consumer's sign-in
// route (existing SSO carries over, AUTH-SIGNIN-1 R6), opens in the same tab, and carries
// the production return context `?from=sign&return=<this Sign Settings URL>`. The
// Organization app accepts that return ONLY when its origin equals the trusted Sign origin
// it reads from the backend and the path is inside /sign/settings/; anything else is
// dropped there, so this link can never become an open redirect.
export function orgLinkWithReturn(orgUrl: string, here: string = window.location.href): string {
  let target: URL;
  try {
    target = new URL(orgUrl);
  } catch {
    return orgUrl;
  }
  const back = new URL(here);
  if (back.pathname.startsWith('/sign/settings/')) {
    target.searchParams.set('from', 'sign');
    target.searchParams.set('return', `${back.origin}${back.pathname}`);
  }
  return ssoEntryHref(target.toString(), 'org');
}
