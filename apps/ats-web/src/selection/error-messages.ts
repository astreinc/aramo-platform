import { ApiError } from '@aramo/fe-foundation';

// Per-module error mapping (the R1/R2/R3 + recruiter-home convention).
// ApiError carries { status, code, details } from the parsed envelope.

export function selectionsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view selections.';
    }
  }
  return 'Selections could not be loaded.';
}

export function selectionDetailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this selection.';
    }
    if (error.status === 404) {
      return 'This selection is not available.';
    }
  }
  return 'This selection could not be loaded.';
}

export function eventsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view the selection event log.';
    }
  }
  return 'The selection event log could not be loaded.';
}

export function transitionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to change this selection.';
    }
    if (error.status === 404) {
      return 'This selection is no longer available.';
    }
    // The control only offers legal targets; this refusal is defense-in-
    // depth (the BE state machine is the source of truth).
    if (error.code === 'SELECTION_STATE_INVALID' || error.status === 422) {
      return 'That move is no longer allowed from the current state. Reload and try again.';
    }
  }
  return 'The selection could not be updated. Please try again.';
}

export function responseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to record a response.';
    }
    if (error.status === 404) {
      return 'This selection is no longer available.';
    }
    if (error.code === 'SELECTION_REFERENCE_NOT_FOUND') {
      return 'The selected outreach could not be found. Reload and try again.';
    }
    if (error.code === 'SELECTION_STATE_INVALID' || error.status === 422) {
      return 'A response can only be recorded while awaiting a response. Reload and try again.';
    }
  }
  return 'The response could not be recorded. Please try again.';
}

export function conversationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to record a conversation.';
    }
    if (error.status === 404) {
      return 'This selection is no longer available.';
    }
    if (error.code === 'SELECTION_STATE_INVALID' || error.status === 422) {
      return 'A conversation can only be recorded after a response. Reload and try again.';
    }
  }
  return 'The conversation could not be recorded. Please try again.';
}

// ---- outreach composer (PR-2) — draft + send error maps ----------------

// Draft (the generation half). 502 AI_PROVIDER_UNAVAILABLE +
// 429 AI_RATE_LIMITED are the LLM-transport failures; 422
// SELECTION_STATE_INVALID is the state-machine refusal (drafting requires
// the talent to be engaged). The soft consent_warning is NOT an error — it
// rides on a 200 response and is surfaced non-blocking by the composer.
export function outreachDraftErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_PROVIDER_UNAVAILABLE' || error.status === 502) {
      return 'The drafting service is temporarily unavailable. Please try again in a moment.';
    }
    if (error.code === 'AI_RATE_LIMITED' || error.status === 429) {
      return 'Too many drafts in a short time. Please wait a moment and try again.';
    }
    if (error.status === 403) {
      return 'You do not have permission to draft outreach.';
    }
    if (error.status === 404) {
      return 'This selection is no longer available.';
    }
    if (error.code === 'SELECTION_STATE_INVALID' || error.status === 422) {
      return 'Outreach can only be drafted once the talent is engaged. Reload and try again.';
    }
  }
  return 'The draft could not be generated. Please try again.';
}

// Send (the delivery half). 403 CONSENT_NOT_GRANTED_AT_SEND is the BINDING,
// NON-overridable consent gate — checked BEFORE the generic 403 so it gets
// its own message (the composer offers no override path; this is distinct
// from the soft draft-time consent_warning).
export function outreachSendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONSENT_NOT_GRANTED_AT_SEND') {
      return 'Consent is not granted for this talent, so this outreach cannot be sent.';
    }
    if (error.status === 403) {
      return 'You do not have permission to send outreach.';
    }
    if (error.status === 404) {
      return 'This selection is no longer available.';
    }
    if (error.code === 'SELECTION_REFERENCE_NOT_FOUND') {
      return 'The draft could not be found. Reload and try again.';
    }
    if (error.code === 'SELECTION_STATE_INVALID' || error.status === 422) {
      return 'This outreach can no longer be sent from the current state. Reload and try again.';
    }
  }
  return 'The outreach could not be sent. Please try again.';
}
