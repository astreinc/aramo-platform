import { ApiError } from '@aramo/fe-foundation';

// Per-module error mapping (the R1/R2/R3 + recruiter-home convention).
// ApiError carries { status, code, details } from the parsed envelope.

export function engagementsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view engagements.';
    }
  }
  return 'Engagements could not be loaded.';
}

export function engagementDetailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this engagement.';
    }
    if (error.status === 404) {
      return 'This engagement is not available.';
    }
  }
  return 'This engagement could not be loaded.';
}

export function eventsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view the engagement event log.';
    }
  }
  return 'The engagement event log could not be loaded.';
}

export function transitionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to change this engagement.';
    }
    if (error.status === 404) {
      return 'This engagement is no longer available.';
    }
    // The control only offers legal targets; this refusal is defense-in-
    // depth (the BE state machine is the source of truth).
    if (error.code === 'ENGAGEMENT_STATE_INVALID' || error.status === 422) {
      return 'That move is no longer allowed from the current state. Reload and try again.';
    }
  }
  return 'The engagement could not be updated. Please try again.';
}

export function responseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to record a response.';
    }
    if (error.status === 404) {
      return 'This engagement is no longer available.';
    }
    if (error.code === 'ENGAGEMENT_REFERENCE_NOT_FOUND') {
      return 'The selected outreach could not be found. Reload and try again.';
    }
    if (error.code === 'ENGAGEMENT_STATE_INVALID' || error.status === 422) {
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
      return 'This engagement is no longer available.';
    }
    if (error.code === 'ENGAGEMENT_STATE_INVALID' || error.status === 422) {
      return 'A conversation can only be recorded after a response. Reload and try again.';
    }
  }
  return 'The conversation could not be recorded. Please try again.';
}
