// COMM-C2B Amendment A1 — Microsoft Graph CALENDAR port (R3/R4/R6). The concrete
// adapter calls graph.microsoft.com /me/events with the delegated Calendars.ReadWrite
// token to create/update/cancel/read the signed-in recruiter's OWN Outlook calendar
// event, with the Talent as a real attendee and a Teams online meeting attached.
//
// This port is SEPARATE from MicrosoftGraphPort: the create-link-only capability
// (no attendees, no invitation) is unchanged and keeps its own port. Only the
// opt-in scheduling capability uses this one.

export const MICROSOFT_CALENDAR_PORT = 'MICROSOFT_CALENDAR_PORT';

/** Classification of a Microsoft Graph provider error, for recovery decisions (R3). */
export type GraphErrorKind =
  | 'reauth_required' // 401 — delegated token invalid/expired; connection needs re-consent
  | 'forbidden' // 403 — permission/authorization denied by the provider
  | 'not_found' // 404 — the referenced provider event does not exist
  | 'throttled' // 429 — provider throttling; carries Retry-After when present
  | 'transient' // 5xx / network — may succeed on retry; outcome can be AMBIGUOUS
  | 'permanent'; // other non-2xx — not retryable

/** A classified Graph failure. `ambiguous` marks outcomes where provider state is UNKNOWN (R3). */
export class GraphCalendarError extends Error {
  constructor(
    readonly kind: GraphErrorKind,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
    /** True when the request may have mutated provider state despite the failure (R3). */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'GraphCalendarError';
  }
}

export interface GraphEventAttendee {
  readonly email: string;
  readonly name?: string;
  readonly type?: 'required' | 'optional';
}

export interface GraphCreateEventArgs {
  readonly accessToken: string;
  readonly subject: string;
  readonly startDateTime: string; // ISO-8601 local-to-timeZone
  readonly endDateTime: string; // ISO-8601 local-to-timeZone
  readonly timeZone: string; // IANA tz
  readonly attendees: readonly GraphEventAttendee[];
  /** Attach a Teams online meeting to the event. */
  readonly isOnlineMeeting: boolean;
  /** Optional plain-text body / agenda. */
  readonly body?: string;
  /**
   * Provider-side duplicate-create guard (R3). Graph MAY reject a second create
   * with the same transactionId; it is NOT a guaranteed lookup key — recovery must
   * not depend on querying by it. Persist a durable op identity regardless.
   */
  readonly transactionId: string;
}

export interface GraphUpdateEventArgs {
  readonly accessToken: string;
  readonly providerEventId: string;
  readonly subject?: string;
  readonly startDateTime?: string;
  readonly endDateTime?: string;
  readonly timeZone?: string;
  readonly attendees?: readonly GraphEventAttendee[];
  readonly body?: string;
}

export interface GraphCancelEventArgs {
  readonly accessToken: string;
  readonly providerEventId: string;
  /** Optional cancellation message sent to attendees by the provider. */
  readonly comment?: string;
}

export interface GraphGetEventArgs {
  readonly accessToken: string;
  readonly providerEventId: string;
}

export interface GraphEventResult {
  readonly provider_event_id: string;
  readonly join_url?: string;
  readonly web_link?: string;
  readonly start_date_time: string;
  readonly end_date_time: string;
  /** Provider lifecycle hint (e.g. 'cancelled'); last-known, never guaranteed-live (R6). */
  readonly status?: string;
}

export interface MicrosoftCalendarPort {
  /** Create the organizer's Outlook event with attendees + Teams meeting (R3/R4). */
  createCalendarEvent(args: GraphCreateEventArgs): Promise<GraphEventResult>;
  /** Update the SAME provider event (reschedule targets event identity, R3). */
  updateCalendarEvent(args: GraphUpdateEventArgs): Promise<GraphEventResult>;
  /** Cancel the SAME provider event; provider notifies attendees (R3). Idempotent on repeat. */
  cancelCalendarEvent(args: GraphCancelEventArgs): Promise<void>;
  /** Read the provider event for reconciliation of an ambiguous outcome (R3/R6). */
  getCalendarEvent(args: GraphGetEventArgs): Promise<GraphEventResult | null>;
}
