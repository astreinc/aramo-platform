// Cross-app "return to the exact originating Settings page" (accepted Settings &
// navigation baseline §C). The prototype expressed it as a hash marker
// (`#<org-page>~<app>~<encoded page>`); production uses a query on the
// Organization URL instead — `/org/<section>?from=<app>&return=<path>` — and it
// is NEVER authorization: it only decides where a "Back to … Settings" link
// points. Hardened like `return_to` (D-ORG-2): only known apps, only a relative
// path inside that app's own base, bounded, no scheme/authority, no `//`, no
// backslash, no control characters. Anything else is ignored silently.

export type ReturnApp = 'ats' | 'sign';

const APP_BASE: Readonly<Record<ReturnApp, string>> = { ats: '/ats/', sign: '/sign/' };
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

export function validReturnPath(app: ReturnApp, path: string): boolean {
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
export function orgHref(section: string, from?: { readonly app: ReturnApp; readonly path: string }): string {
  const base = `/org/${encodeURIComponent(section)}`;
  if (from === undefined || !validReturnPath(from.app, from.path)) return base;
  return `${base}?from=${from.app}&return=${encodeURIComponent(from.path)}`;
}

/** Parse `?from=&return=` from a location search string. Invalid → null. */
export function parseReturnContext(search: string): ReturnContext | null {
  const params = new URLSearchParams(search);
  const app = params.get('from');
  const path = params.get('return');
  if (!isReturnApp(app) || path === null || !validReturnPath(app, path)) return null;
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
export function readRememberedReturnContext(): ReturnContext | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as { app?: unknown; href?: unknown };
    if (typeof v.app !== 'string' || typeof v.href !== 'string') return null;
    if (!isReturnApp(v.app) || !validReturnPath(v.app, v.href)) return null;
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
