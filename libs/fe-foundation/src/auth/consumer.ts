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

export type AuthPathKind =
  | 'login'
  | 'session'
  | 'logout'
  | 'refresh'
  | 'callback';

/** Build an auth-service path for the configured consumer, e.g. /auth/platform/login. */
export function authPath(kind: AuthPathKind): string {
  return `/auth/${authConsumer}/${kind}`;
}
