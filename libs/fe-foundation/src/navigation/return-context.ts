import { ssoEntryHref } from '../platform/products';
// Cross-app "return to the exact originating Settings page" (accepted Settings &
// navigation baseline §C). The prototype expressed it as a hash marker
// (`#<org-page>~<app>~<encoded page>`); production uses a query on the
// Organization URL instead — `/org/<section>?from=<app>&return=<path>` — and it
// is NEVER authorization: it only decides where a "Back to … Settings" link
// points. Hardened like `return_to` (D-ORG-2): only known apps, only a relative
// path inside that app's own base, bounded, no scheme/authority, no `//`, no
// backslash, no control characters. Anything else is ignored silently.
//
// ORG-UX-1 (Directive v1.0 LOCKED §7.2, Lead Correction C; amends the wording of
// doc/10-multi-product-app-home-and-org-consumer.md:167-169) — Aramo Sign lives on its own
// host, so a Sign return is an ABSOLUTE URL, accepted ONLY when BOTH hold:
//   * its origin equals the TRUSTED Sign origin (the `sign` entry of GET /v1/me/products,
//     configured server-side by ARAMO_SIGN_ENTRY_URL — passed in, never read from the URL)
//   * its path lies inside the permitted Sign Settings prefix (/sign/settings/)
// No credentials, no other origin, no other path, bounded, no control characters. It is
// only ever rendered as a Back link — never followed automatically (no open redirect).

export type ReturnApp = 'ats' | 'sign';

const APP_BASE: Readonly<Record<ReturnApp, string>> = { ats: '/ats/', sign: '/sign/' };
// ORG-UX-1 §7.2 — the only Sign pages a "Back to Sign Settings" link may point at.
export const SIGN_SETTINGS_PATH_PREFIX = '/sign/settings/';

/** Options for validating a Sign return (the trusted origin comes from the backend). */
export interface ReturnValidationOptions {
  /** Trusted Sign origin (e.g. https://sign.aramo.ai), or null/undefined when unknown. */
  readonly signOrigin?: string | null;
}

/** The trusted Sign origin from the products view's `sign` entry_path, else null. */
export function trustedSignOrigin(signEntryPath: string | null | undefined): string | null {
  if (typeof signEntryPath !== 'string' || !/^https?:\/\//i.test(signEntryPath)) return null;
  try {
    return new URL(signEntryPath).origin;
  } catch {
    return null;
  }
}
const BACK_LABEL: Readonly<Record<ReturnApp, string>> = {
  ats: 'Back to ATS Settings',
  sign: 'Back to Sign Settings',
};
const STORAGE_KEY = 'aramo.org.return';
const MAX_LEN = 512;

export interface ReturnContext {
  readonly app: ReturnApp;
  /** Validated same-host relative path inside the app's base. */
  readonly href: string;
  readonly label: string;
}

function isReturnApp(v: string | null): v is ReturnApp {
  return v === 'ats' || v === 'sign';
}

function hasControlOrSpace(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

// ORG-UX-1 §7.2 — an absolute Sign Settings URL on the trusted Sign origin only.
function validSignReturnUrl(url: string, signOrigin: string | null | undefined): boolean {
  if (signOrigin === null || signOrigin === undefined) return false;
  if (url.length === 0 || url.length > MAX_LEN || hasControlOrSpace(url) || url.includes('\\')) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username !== '' || u.password !== '') return false;
  if (u.origin !== signOrigin) return false;
  // The URL as written must be exactly origin + path(+query) — no encoded tricks that
  // normalize into the prefix.
  if (!url.startsWith(`${signOrigin}${SIGN_SETTINGS_PATH_PREFIX}`)) return false;
  if (!u.pathname.startsWith(SIGN_SETTINGS_PATH_PREFIX) || u.pathname.includes('//') || /%2f|%5c|%2e/i.test(url)) return false;
  return u.hash === '';
}

export function validReturnPath(app: ReturnApp, path: string, opts: ReturnValidationOptions = {}): boolean {
  if (app === 'sign') return validSignReturnUrl(path, opts.signOrigin);
  if (path.length === 0 || path.length > MAX_LEN) return false;
  if (!path.startsWith(APP_BASE[app])) return false;
  if (path.includes('//') || path.includes('\\')) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    // No control characters or whitespace (explicit code-point check; a control
    // class in a regex literal is lint-restricted).
    if (c <= 0x20 || c === 0x7f) return false;
  }
  // No scheme-like segment before the query (defence in depth; the prefix check
  // already pins a leading `/<app>/`).
  const beforeQuery = path.split('?')[0] ?? '';
  if (beforeQuery.includes(':')) return false;
  return true;
}

/** The Organization URL for a section, optionally carrying the return context. */
export function orgHref(
  section: string,
  from?: { readonly app: ReturnApp; readonly path: string },
  opts: ReturnValidationOptions = {},
): string {
  const base = `/org/${encodeURIComponent(section)}`;
  if (from === undefined || !validReturnPath(from.app, from.path, opts)) return base;
  return `${base}?from=${from.app}&return=${encodeURIComponent(from.path)}`;
}

/** Parse `?from=&return=` from a location search string. Invalid → null. */
export function parseReturnContext(search: string, opts: ReturnValidationOptions = {}): ReturnContext | null {
  const params = new URLSearchParams(search);
  const app = params.get('from');
  const path = params.get('return');
  if (!isReturnApp(app) || path === null || !validReturnPath(app, path, opts)) return null;
  return { app, href: path, label: BACK_LABEL[app] };
}

export function rememberReturnContext(ctx: ReturnContext): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ app: ctx.app, href: ctx.href }));
  } catch {
    /* storage unavailable — the Back link still works on the landing page */
  }
}

/** The remembered context, re-validated on every read (storage is untrusted). */
export function readRememberedReturnContext(opts: ReturnValidationOptions = {}): ReturnContext | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as { app?: unknown; href?: unknown };
    if (typeof v.app !== 'string' || typeof v.href !== 'string') return null;
    if (!isReturnApp(v.app) || !validReturnPath(v.app, v.href, opts)) return null;
    return { app: v.app, href: v.href, label: BACK_LABEL[v.app] };
  } catch {
    return null;
  }
}

export function clearReturnContext(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * orgHref for a link from ANOTHER app (ATS): through the org consumer's sign-in
 * route, so the existing SSO session carries over instead of the Organization app
 * asking a signed-in user to sign in again (AUTH-SIGNIN-1 R6). See ssoEntryHref.
 */
export function orgEntryHref(
  section: string,
  from?: { readonly app: ReturnApp; readonly path: string },
  opts: ReturnValidationOptions = {},
): string {
  return ssoEntryHref(orgHref(section, from, opts), 'org');
}
