import type { ConsumerType } from '@aramo/auth';

// Increment-3 PR-3.1 (Host-Derived Auth Base) — the OAuth callback base, the
// post-login redirect, and the signout redirect all derive from the request's
// VALIDATED host, so astre.aramo.ai / admin.aramo.ai / both localhost consoles
// authenticate concurrently with zero env-flipping, and the Increment-1
// pkce_state_missing host-divergence class is extinguished by construction
// (cookie-host == login-host == callback-host).
//
// SECURITY INVARIANT (§2, non-negotiable): a raw Host header NEVER reaches a
// redirect. `deriveBaseFromHost` returns a base ONLY for a host that validates
// against one of the three allowlists (tenant / platform / dev); everything else
// returns null and the caller falls back to the env chain — never to the
// presented host. The hostile-host case (`Host: evil.com` → null → env fallback)
// is a required spec.
//
// This preserves Increment-1 Amendment v1.2: the callback path's consumer
// segment is DERIVED from the login-time consumer sealed into the PKCE state, so
// login and callback consumers cannot diverge; OAuth's "exchange redirect_uri ==
// authorize redirect_uri" holds because both legs derive from the same consumer
// AND the same (browser-presented, hence identical) host.
//
// Scope guard (§3e): PKCE mechanics, cookie attributes, verifier, reconcile
// spine, link guard, and consumer-compare are byte-untouched — this is
// redirect/base resolution only.

// ── Dev posture (mirrors auth.controller.ts shouldSetSecure()) ────────────────
// The localhost carve-out is permitted ONLY when the insecure-cookies dev
// condition holds — the SAME env posture shouldSetSecure() reads (kept in sync;
// not imported to avoid touching the §2-adjacent cookie helper). shouldSetSecure
// = NODE_ENV==='production' ? true : AUTH_ALLOW_INSECURE_COOKIES !== 'true';
// so the dev (insecure) posture is its negation.
function isDevPosture(): boolean {
  return (
    process.env['NODE_ENV'] !== 'production' &&
    process.env['AUTH_ALLOW_INSECURE_COOKIES'] === 'true'
  );
}

interface ParsedHost {
  /** lowercased hostname, port stripped (for matching + prod base). */
  readonly hostname: string;
  /** the port, or null. */
  readonly port: string | null;
  /** lowercased host verbatim incl. port (for the dev base, which needs the port). */
  readonly raw: string;
}

function parseHost(rawHost: string | undefined): ParsedHost | null {
  if (rawHost === undefined) return null;
  const raw = rawHost.trim().toLowerCase();
  if (raw.length === 0) return null;
  // Reject anything with a path/scheme/whitespace — a Host header is host[:port].
  if (/[/\\\s]/.test(raw) || raw.includes('://')) return null;
  const colon = raw.lastIndexOf(':');
  // Guard IPv6-ish inputs (multiple colons) — not a shape we serve; refuse.
  if (raw.indexOf(':') !== colon) return null;
  const hostname = colon === -1 ? raw : raw.slice(0, colon);
  const port = colon === -1 ? null : raw.slice(colon + 1);
  if (hostname.length === 0) return null;
  if (port !== null && !/^[0-9]+$/.test(port)) return null;
  return { hostname, port, raw };
}

function isDevHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

// Platform hosts (§3a.2): AUTH_PLATFORM_HOSTS, comma-separated exact hosts,
// lowercased + port-stripped (consistent with tenant matching). Prod default is
// supplied via env (admin.aramo.ai); empty when unset.
function platformHostSet(): ReadonlySet<string> {
  return hostSetFromEnv(process.env['AUTH_PLATFORM_HOSTS']);
}

// Portal P1 — the portal host class (candidate.aramo.ai), mirroring the
// platform class exactly: an exact-match allowlist from AUTH_PORTAL_HOSTS, so
// a raw Host header NEVER reaches a redirect unless it validates against the
// allowlist. Empty when unset.
function portalHostSet(): ReadonlySet<string> {
  return hostSetFromEnv(process.env['AUTH_PORTAL_HOSTS']);
}

// Shared parse for an exact-match host allowlist env var: comma-split, trim,
// lowercase, strip port, drop empties; empty set when unset.
function hostSetFromEnv(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.length === 0) return new Set();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .map((h) => {
        const colon = h.lastIndexOf(':');
        return colon === -1 ? h : h.slice(0, colon);
      })
      .filter((h) => h.length > 0),
  );
}

// The three-class host validator + base builder. Returns the derived base
// (`scheme://host`) for a validated host, or null. `isTenantHost` is computed by
// the caller (a single findActiveBySlug — see HostBaseResolver) so this stays a
// pure, unit-testable function.
//   - dev host (localhost/127.0.0.1) under dev posture → http://<host:port>
//   - platform host (AUTH_PLATFORM_HOSTS exact match)  → https://<hostname>
//   - portal host (AUTH_PORTAL_HOSTS exact match) → https://<hostname>
//   - tenant host (caller-validated)                   → https://<hostname>
//   - anything else                                    → null (env fallback)
export function deriveBaseFromHost(
  rawHost: string | undefined,
  opts: { readonly isTenantHost: boolean },
): string | null {
  const parsed = parseHost(rawHost);
  if (parsed === null) return null;
  if (isDevHostname(parsed.hostname)) {
    return isDevPosture() ? `http://${parsed.raw}` : null;
  }
  if (platformHostSet().has(parsed.hostname)) {
    return `https://${parsed.hostname}`;
  }
  // Portal P1 — portal host class, sibling to platform (exact-match allowlist).
  if (portalHostSet().has(parsed.hostname)) {
    return `https://${parsed.hostname}`;
  }
  if (opts.isTenantHost) {
    return `https://${parsed.hostname}`;
  }
  return null;
}

// Base URL resolution (§3c precedence): validated-host derivation FIRST →
// AUTH_PUBLIC_BASE_URL env → legacy AUTH_COGNITO_REDIRECT_URI origin → null
// (existing cognito_env_missing posture unchanged). `derivedBase` is the output
// of deriveBaseFromHost (null when the host did not validate). With envs unset
// locally, both consoles derive on their own ports with no flips; envs remain the
// escape hatch for unvalidated hosts and existing tests.
export function resolvePublicBaseUrl(derivedBase?: string | null): string | null {
  if (derivedBase !== undefined && derivedBase !== null && derivedBase.length > 0) {
    return derivedBase.replace(/\/+$/, '');
  }
  const explicit = process.env['AUTH_PUBLIC_BASE_URL'];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.replace(/\/+$/, '');
  }
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

// Build the callback URL for a consumer: `${base}/auth/${consumer}/callback`.
// `derivedBase` (from the request host) wins over the env chain. Null only when
// no base resolves at all (caller throws cognito_env_missing / exchange-env).
export function deriveRedirectUri(
  consumer: ConsumerType,
  derivedBase?: string | null,
): string | null {
  const base = resolvePublicBaseUrl(derivedBase);
  if (base === null) return null;
  return `${base}/auth/${consumer}/callback`;
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

// Post-login target (§3d.2): a VALIDATED host lands the user back on the
// originating host — `${derivedBase}${AUTH_POST_LOGIN_PATH ?? '/'}`. For an
// unvalidated host (derivedBase null), fall back to the legacy full-URL
// AUTH_POST_LOGIN_REDIRECT (existing behavior preserved). Null when neither is
// available — the caller's post_login_redirect_missing throw posture survives.
export function derivePostLoginRedirect(
  derivedBase?: string | null,
): string | null {
  if (derivedBase !== undefined && derivedBase !== null && derivedBase.length > 0) {
    const path = process.env['AUTH_POST_LOGIN_PATH'] ?? '/';
    return `${derivedBase.replace(/\/+$/, '')}${ensureLeadingSlash(path)}`;
  }
  const legacy = process.env['AUTH_POST_LOGIN_REDIRECT'];
  return legacy !== undefined && legacy.length > 0 ? legacy : null;
}

// Signout return URL (§3d.3): same treatment — VALIDATED host →
// `${derivedBase}${AUTH_SIGNOUT_PATH ?? '/'}`; else legacy full-URL
// AUTH_COGNITO_SIGNOUT_REDIRECT; else null (signout_redirect_missing throw
// survives). Never the raw host — this is a registered/allowlisted value only.
export function deriveSignoutRedirect(
  derivedBase?: string | null,
): string | null {
  if (derivedBase !== undefined && derivedBase !== null && derivedBase.length > 0) {
    const path = process.env['AUTH_SIGNOUT_PATH'] ?? '/';
    return `${derivedBase.replace(/\/+$/, '')}${ensureLeadingSlash(path)}`;
  }
  const legacy = process.env['AUTH_COGNITO_SIGNOUT_REDIRECT'];
  return legacy !== undefined && legacy.length > 0 ? legacy : null;
}
