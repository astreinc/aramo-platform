import { ApiError } from '@aramo/fe-foundation';

import { safeErrorMessage } from '../ui/errors';

// M365-SCHED-1 PR 1B — governed, product-safe mapping of backend Outlook-scheduling
// error codes to FE copy + interaction affordances. Reads only the typed
// `{ code, status, details }` surface (never the raw developer `.message`).
//
// `retryable` is the safety gate the UI MUST honor: it is FALSE for any outcome
// where re-sending could duplicate or is otherwise unsafe — notably UNRESOLVED
// (uncertain provider outcome), IN_PROGRESS, and IDEMPOTENCY_CONFLICT. There is NO
// frontend reconciliation endpoint, so an unresolved outcome is never offered a
// "reconcile" action and the copy never promises that checking Outlook alone
// restores Aramo's durable state (COMM-C2B Amendment A1, R3/R6).

export interface CalendarMeetingError {
  readonly message: string;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly operationReference: string | null;
  readonly needsReconnect: boolean;
}

export function describeCalendarMeetingError(error: unknown): CalendarMeetingError {
  if (error instanceof ApiError) {
    const code = error.code ?? null;
    const operationReference =
      typeof error.details?.['operation_id'] === 'string'
        ? (error.details['operation_id'] as string)
        : null;

    switch (error.code) {
      case 'MICROSOFT_SCHEDULING_UNRESOLVED':
        return {
          message:
            "This meeting's outcome could not be confirmed, so Aramo did not record it as scheduled. Do not resend — a duplicate invitation could be created. Please contact your administrator or operations support to resolve it" +
            (operationReference !== null ? ` (reference ${operationReference}).` : '.'),
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_MEETING_VERSION_CONFLICT':
        return {
          message: 'This meeting was just updated somewhere else. Refresh to load the latest, then try again.',
          code,
          retryable: true,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_REAUTHORIZATION_REQUIRED':
        return {
          message: 'Your Microsoft 365 connection needs to be re-authorized before scheduling. Reconnect your account, then try again.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: true,
        };
      case 'COMMUNICATION_MEETING_CONSENT_DENIED':
        return {
          message: 'An Outlook invitation cannot be sent to this Talent because contacting consent is not in place.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_MEETING_ASSOCIATION_INVALID':
        return {
          message: 'This meeting is not associated with a current recruiting relationship for this Talent and requisition.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_SCHEDULING_IN_PROGRESS':
        return {
          message: 'Another scheduling attempt for this meeting is already in progress. Wait for it to finish before trying again.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_SCHEDULING_IDEMPOTENCY_CONFLICT':
        return {
          message: 'This looks like a different meeting using a key from an earlier request. Start a new scheduling action.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_MEETING_NOT_ORGANIZER':
        return {
          message: 'Only the recruiter who organized this meeting can change it. You do not have permission to modify it.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_MEETING_NOT_FOUND':
        return {
          message: 'This meeting is no longer available. It may have been removed, or your access has changed.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_MEETING_NOT_SCHEDULING':
        return {
          message: 'This is a Teams link, not a scheduled Outlook meeting, so it cannot be rescheduled or cancelled here.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE':
        return {
          message: 'This Talent has no contactable email, so an Outlook invitation cannot be sent.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_PROVIDER_ERROR':
        return {
          message: 'Microsoft 365 could not complete this request right now. Please try again in a few minutes.',
          code,
          retryable: true,
          operationReference,
          needsReconnect: false,
        };
      case 'MICROSOFT_PROVIDER_NOT_CONFIGURED':
        return {
          message: 'Microsoft 365 is not configured for your organization yet. Contact your administrator.',
          code,
          retryable: false,
          operationReference,
          needsReconnect: false,
        };
      default:
        break;
    }

    if (error.status === 403) {
      return { message: 'You do not have permission to perform this scheduling action.', code, retryable: false, operationReference, needsReconnect: false };
    }
    if (error.status === 404) {
      return { message: 'This meeting is no longer available.', code, retryable: false, operationReference, needsReconnect: false };
    }
  }

  return {
    message: safeErrorMessage(error, 'Something went wrong with this meeting. Please try again.'),
    code: null,
    retryable: true,
    operationReference: null,
    needsReconnect: false,
  };
}
