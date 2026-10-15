// Shared Microsoft-integration error → governed AramoError mapping (extracted
// verbatim from MicrosoftAuthorizationController.mapError so the TIP-E2E INC-3 A1
// screening meeting routes map the SAME failures to the SAME token-free codes).
import { AramoError } from '@aramo/common';
import {
  GraphCalendarError,
  MicrosoftIdentityNotBoundError,
  MicrosoftReauthRequiredError,
} from '@aramo/microsoft-graph';

import { CalendarInviteConsentDeniedError } from './calendar-invite-consent-gate.port.js';
import { MeetingAssociationError } from './meeting-association.validator.js';
import {
  MeetingIdempotencyConflictError,
  MeetingNotFoundError,
  MeetingNotSchedulingError,
  MeetingOperationInProgressError,
  MeetingOrganizerMismatchError,
  MeetingScheduleUnresolvedError,
  MeetingVersionConflictError,
  TalentContactUnavailableError,
} from './microsoft-scheduling.service.js';
import { EmailConsentDeniedError } from './email-consent-gate.port.js';
import { TalentEmailUnavailableError } from './email-recipient-resolver.port.js';
import { MicrosoftProviderNotConfiguredError } from './microsoft-provider-not-configured.error.js';
export function mapMicrosoftError(err: unknown, requestId: string, logger: { error(message: string): void }): AramoError {
    if (err instanceof EmailConsentDeniedError) {
      return new AramoError('COMMUNICATION_EMAIL_CONSENT_DENIED', 'contacting consent does not permit email', 409, { requestId });
    }
    if (err instanceof MicrosoftReauthRequiredError || err instanceof MicrosoftIdentityNotBoundError) {
      return new AramoError('MICROSOFT_REAUTHORIZATION_REQUIRED', 'microsoft identity requires (re)authorization', 409, { requestId });
    }
    // A1 (M365-SCHED-1) — Outlook scheduling refusals → typed, token-free codes.
    if (err instanceof CalendarInviteConsentDeniedError) {
      return new AramoError('COMMUNICATION_MEETING_CONSENT_DENIED', 'contacting consent does not permit a calendar invitation', 409, { requestId });
    }
    if (err instanceof MeetingAssociationError) {
      // Cross-tenant or invalid recruiting association — generic message (no leak).
      return new AramoError('MICROSOFT_MEETING_ASSOCIATION_INVALID', 'the Talent and Requisition are not a valid recruiting association', 422, { requestId });
    }
    if (err instanceof MeetingScheduleUnresolvedError) {
      return new AramoError('MICROSOFT_SCHEDULING_UNRESOLVED', 'scheduling outcome is unresolved; reconcile before retrying', 409, { requestId, details: { operation_id: err.operation_id } });
    }
    if (err instanceof MeetingNotFoundError) {
      return new AramoError('MICROSOFT_MEETING_NOT_FOUND', 'scheduling meeting not found', 404, { requestId });
    }
    if (err instanceof MeetingOrganizerMismatchError) {
      return new AramoError('MICROSOFT_MEETING_NOT_ORGANIZER', 'only the organizing recruiter may modify this meeting', 403, { requestId });
    }
    if (err instanceof MeetingVersionConflictError) {
      return new AramoError('MICROSOFT_MEETING_VERSION_CONFLICT', 'meeting was modified concurrently; refresh and retry', 409, { requestId });
    }
    if (err instanceof MeetingIdempotencyConflictError) {
      return new AramoError('MICROSOFT_SCHEDULING_IDEMPOTENCY_CONFLICT', 'idempotency key is bound to a different scheduling request', 409, { requestId });
    }
    if (err instanceof MeetingOperationInProgressError) {
      return new AramoError('MICROSOFT_SCHEDULING_IN_PROGRESS', 'a concurrent scheduling attempt is in progress', 409, { requestId });
    }
    if (err instanceof MeetingNotSchedulingError) {
      return new AramoError('MICROSOFT_MEETING_NOT_SCHEDULING', 'meeting is not an Outlook scheduling meeting', 409, { requestId });
    }
    if (err instanceof TalentContactUnavailableError) {
      return new AramoError('COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE', 'the Talent has no authoritative email for an invitation', 422, { requestId });
    }
    if (err instanceof GraphCalendarError) {
      if (err.kind === 'reauth_required') {
        return new AramoError('MICROSOFT_REAUTHORIZATION_REQUIRED', 'microsoft identity requires (re)authorization', 409, { requestId });
      }
      return new AramoError('MICROSOFT_PROVIDER_ERROR', 'microsoft calendar provider error', 502, { requestId });
    }
    if (err instanceof MicrosoftProviderNotConfiguredError) {
      // The tenant genuinely has no usable connection — an expected 409, not a failure.
      return new AramoError('MICROSOFT_PROVIDER_NOT_CONFIGURED', err.message, 409, { requestId });
    }
    if (err instanceof TalentEmailUnavailableError) {
      // COMM-C4 — the Talent has no authoritative email1; fail-closed (422). The
      // send never reached Graph and wrote no evidence.
      return new AramoError('COMMUNICATION_EMAIL_RECIPIENT_UNAVAILABLE', 'the Talent has no authoritative email for send', 422, { requestId });
    }
    if (err instanceof AramoError) {
      return err;
    }
    // Anything else is an UNEXPECTED / infrastructure failure — e.g. a Secrets
    // Manager AccessDeniedException when persisting the client secret. It must NOT
    // be masked as a misleading "provider not configured" 409 (that hid a real
    // IAM gap and produced zero logs). Log the true cause (name + message carry
    // no secret VALUES — the client secret is never in these errors) and surface
    // it as a 500 via the registry's INTERNAL_ERROR catch-all.
    logger.error(
      `microsoft operation failed [${requestId}]: ${
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }`,
    );
    return new AramoError('INTERNAL_ERROR', 'microsoft operation failed', 500, { requestId });
}
