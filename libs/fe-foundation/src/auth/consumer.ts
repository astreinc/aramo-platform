// Auth consumer configuration (Platform-Console Inc-2 PR-2).
//
// The auth-service exposes its login/session/callback/logout/refresh routes as
// `/auth/:consumer/*` (auth.controller.ts @Controller('auth/:consumer')), and
// the `session` route REJECTS a token whose consumer_type ≠ the :consumer path
// segment. The FE foundation historically hardcoded the `recruiter` consumer
// (LOGIN_PATH / SESSION_PATH / LOGOUT_PATH in auth/session.ts + REFRESH_PATH in
// api/client.ts), which is correct for ats-web but blocks platform-web (whose
// token is consumer_type='platform').
//
// This module is the SINGLE bootstrap point: an app calls configureAuthConsumer
// ONCE at startup; every auth path in session.ts + api/client.ts derives from it.
// Default 'recruiter' → ats-web (and every existing caller) is byte-unchanged.
// platform-web calls configureAuthConsumer('platform') in its main.tsx.
//
// Lives in its own module (not session.ts) so both session.ts and api/client.ts
// consume it without the client.ts ↔ session.ts import cycle.

let authConsumer = 'recruiter';

/**
 * Set the auth-service consumer this FE authenticates as. Call ONCE at app
 * bootstrap, before the first session fetch. Default is 'recruiter'.
 */
export function configureAuthConsumer(consumer: string): void {
  authConsumer = consumer;
}

/** The currently-configured consumer (default 'recruiter'). */
export function getAuthConsumer(): string {
  return authConsumer;
}

// D-ORG-2 (topology T1) — the path PREFIX this app is served under on the tenant
// host: '' for App Home at `/` (apps/home-web), '/ats' for the ATS app at `/ats/`
// (apps/ats-web). Router `basename` handles in-app links; this value is for the
// few HOST-level navigations the foundation performs itself (the `/login?error=`
// landing, `return_to` on the login redirect). Call ONCE at bootstrap.
let appBasePath = '';
export function configureAppBasePath(basePath: string): void {
  appBasePath = basePath.replace(/\/+$/, '');
}
export function getAppBasePath(): string {
  return appBasePath;
}
/** Prefix an in-app absolute path with the app base: appPath('/login') → '/ats/login'. */
export function appPath(path: string): string {
  return `${appBasePath}${path.startsWith('/') ? path : `/${path}`}`;
}

export type AuthPathKind =
  | 'login'
  | 'session'
  | 'logout'
  | 'refresh'
  | 'callback'
  | 'login-options';

/**
 * Build an auth-service path for the configured consumer, e.g. /auth/platform/login.
 * `consumer` overrides it only for the sign-in page's allowlisted `?consumer=`
 * (AUTH-SIGNIN-1 §3.2.1).
 */
export function authPath(kind: AuthPathKind, consumer: string = authConsumer): string {
  return `/auth/${consumer}/${kind}`;
}
