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
 * Read/write the signed-in user's OWN Outlook calendar — ONLY for the separately
 * enabled scheduling capability (COMM-C2B Amendment A1, R4/R8). NOT part of the
 * baseline set; a recruiter who has not enabled scheduling never requests it.
 */
export const MS_SCOPE_CALENDARS_RW = 'Calendars.ReadWrite';

/**
 * The COMPLETE authorized BASELINE delegated scope set for COMM-C2B — the only set
 * Aramo may request from Microsoft for the send-only + create-link-only
 * capabilities. Array order is the request order. Calendar access is NOT here.
 */
export const MICROSOFT_DELEGATED_SCOPES = Object.freeze([
  MS_SCOPE_OPENID,
  MS_SCOPE_PROFILE,
  MS_SCOPE_OFFLINE_ACCESS,
  MS_SCOPE_USER_READ,
  MS_SCOPE_MAIL_SEND,
  MS_SCOPE_ONLINE_MEETINGS_RW,
] as const);

/**
 * The authorized scope set for the separately enabled Outlook scheduling
 * capability (COMM-C2B Amendment A1, R4): the baseline set PLUS exactly
 * Calendars.ReadWrite. Requested only when a recruiter explicitly enables and
 * consents to scheduling; this never widens the baseline posture.
 */
export const MICROSOFT_SCHEDULING_SCOPES = Object.freeze([
  ...MICROSOFT_DELEGATED_SCOPES,
  MS_SCOPE_CALENDARS_RW,
] as const);

export type MicrosoftDelegatedScope = (typeof MICROSOFT_DELEGATED_SCOPES)[number];

/**
 * Which delegated capability a scope request belongs to. 'baseline' is the
 * send-only + create-link-only posture (default); 'scheduling' additionally
 * authorizes Calendars.ReadWrite (Amendment A1, R4).
 */
export type MicrosoftScopeCapability = 'baseline' | 'scheduling';

const AUTHORIZED_BASELINE = new Set<string>(MICROSOFT_DELEGATED_SCOPES);
const AUTHORIZED_SCHEDULING = new Set<string>(MICROSOFT_SCHEDULING_SCOPES);

function authorizedSetFor(capability: MicrosoftScopeCapability): ReadonlySet<string> {
  return capability === 'scheduling' ? AUTHORIZED_SCHEDULING : AUTHORIZED_BASELINE;
}

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
 * Fail-closed guard (R8, Amendment A1 R4): every requested scope MUST be a member
 * of the capability's authorized least-privilege set; any scope outside it must
 * also clear the forbidden-pattern defense-in-depth. Throws
 * MicrosoftScopeViolationError on the first violation. The authorize-URL builder
 * MUST pass its scope list through this guard before contacting Microsoft.
 *
 * Capability gating (A1 R4): the 'scheduling' capability admits EXACTLY the
 * baseline set plus the Calendars.ReadWrite literal; the default 'baseline'
 * capability still fails closed on all Calendars.* — so an opt-in scheduling
 * request widens nothing for recruiters who have not enabled scheduling.
 */
export function assertLeastPrivilegeScopes(
  requested: readonly string[],
  capability: MicrosoftScopeCapability = 'baseline',
): void {
  const authorized = authorizedSetFor(capability);
  for (const scope of requested) {
    // Explicitly authorized for this capability — bypasses the broad forbidden
    // patterns (which exist to catch anything NOT in the authorized set).
    if (authorized.has(scope)) {
      continue;
    }
    for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(scope)) {
        throw new MicrosoftScopeViolationError(
          scope,
          `Microsoft scope '${scope}' exceeds the COMM-C2B least-privilege model (R8)`,
        );
      }
    }
    throw new MicrosoftScopeViolationError(
      scope,
      `Microsoft scope '${scope}' is not in the authorized COMM-C2B '${capability}' delegated set (R8)`,
    );
  }
}

/** The baseline authorized scope set as the space-delimited string for an OAuth request. */
export function microsoftScopeParam(): string {
  return MICROSOFT_DELEGATED_SCOPES.join(' ');
}

/** The scheduling-capability scope set as the space-delimited string (A1 R4). */
export function microsoftSchedulingScopeParam(): string {
  return MICROSOFT_SCHEDULING_SCOPES.join(' ');
}
