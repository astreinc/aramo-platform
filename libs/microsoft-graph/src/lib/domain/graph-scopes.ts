// COMM-C2B — Microsoft Graph DELEGATED least-privilege scope set (directive R8).
//
// The load-bearing security invariant: Aramo requests ONLY the delegated
// permissions its delivered C2B capabilities need — basic signed-in identity,
// send mail AS the signed-in user, and create/manage the signed-in organizer's
// OWN online (Teams) meeting. It requests NO mailbox read, NO calendar-wide
// scope, NO directory permission, and NO application/tenant-wide permission.
// Any widening requires an Architect amendment (R8); this module FAILS CLOSED on
// a request that escapes the authorized set.

/** Basic signed-in user identity (delegated). */
export const MS_SCOPE_OPENID = 'openid';
export const MS_SCOPE_PROFILE = 'profile';
/** Server-side refresh; the browser never receives a refresh token (R2). */
export const MS_SCOPE_OFFLINE_ACCESS = 'offline_access';
/** Read the signed-in user's OWN profile — recruiter↔Microsoft identity binding (R6). */
export const MS_SCOPE_USER_READ = 'User.Read';
/** Send mail AS the signed-in user. Send-only; grants NO mailbox read (R8/R9). */
export const MS_SCOPE_MAIL_SEND = 'Mail.Send';
/** Create/manage the signed-in organizer's OWN online (Teams) meeting. No calendar/mailbox (R8). */
export const MS_SCOPE_ONLINE_MEETINGS_RW = 'OnlineMeetings.ReadWrite';

/**
 * The COMPLETE authorized delegated scope set for COMM-C2B — the only set Aramo
 * may request from Microsoft. Array order is the request order.
 */
export const MICROSOFT_DELEGATED_SCOPES = Object.freeze([
  MS_SCOPE_OPENID,
  MS_SCOPE_PROFILE,
  MS_SCOPE_OFFLINE_ACCESS,
  MS_SCOPE_USER_READ,
  MS_SCOPE_MAIL_SEND,
  MS_SCOPE_ONLINE_MEETINGS_RW,
] as const);

export type MicrosoftDelegatedScope = (typeof MICROSOFT_DELEGATED_SCOPES)[number];

const AUTHORIZED = new Set<string>(MICROSOFT_DELEGATED_SCOPES);

/**
 * Forbidden delegated/application scope shapes that would exceed the locked
 * least-privilege model (R8). Defense-in-depth on top of the positive allowlist:
 * these produce a precise failure if a future edit tries to widen authority
 * (mailbox read, shared/impersonation send, calendar-wide, directory-wide,
 * application/tenant-wide, or unrelated resource scopes).
 */
export const FORBIDDEN_SCOPE_PATTERNS: readonly RegExp[] = Object.freeze([
  /mail\.read/i, // mailbox read / ReadWrite — no inbox ingestion (R9)
  /\.shared$/i, // send/act AS another user — impersonation (R1/R8)
  /calendars?\./i, // calendar-wide — meeting is OnlineMeetings-only (R8)
  /directory\./i, // directory-wide (R8)
  /\.all$/i, // application-wide / tenant-wide (R8; application permissions forbidden)
  /^(sites|files|contacts|people|group|groupmember)\./i, // unrelated resource scopes
]);

export class MicrosoftScopeViolationError extends Error {
  constructor(
    readonly scope: string,
    message: string,
  ) {
    super(message);
    this.name = 'MicrosoftScopeViolationError';
  }
}

/**
 * Fail-closed guard (R8): every requested scope MUST be a member of the
 * authorized least-privilege set AND must not match a forbidden pattern. Throws
 * MicrosoftScopeViolationError on the first violation. The authorize-URL builder
 * MUST pass its scope list through this guard before contacting Microsoft.
 */
export function assertLeastPrivilegeScopes(requested: readonly string[]): void {
  for (const scope of requested) {
    for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(scope)) {
        throw new MicrosoftScopeViolationError(
          scope,
          `Microsoft scope '${scope}' exceeds the COMM-C2B least-privilege model (R8)`,
        );
      }
    }
    if (!AUTHORIZED.has(scope)) {
      throw new MicrosoftScopeViolationError(
        scope,
        `Microsoft scope '${scope}' is not in the authorized COMM-C2B delegated set (R8)`,
      );
    }
  }
}

/** The authorized scope set as the space-delimited string for an OAuth request. */
export function microsoftScopeParam(): string {
  return MICROSOFT_DELEGATED_SCOPES.join(' ');
}
