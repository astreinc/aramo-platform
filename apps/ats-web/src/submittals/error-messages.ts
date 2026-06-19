import { ApiError } from '@aramo/fe-foundation';

// R6 — surface the BE-typed code/details cleanly. Distinct messages for
// the wizard's load-bearing refusal codes (R9 stretch-block; the 3
// attestations refusal; idempotency-key conflict; transition guards).

export function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SUBMITTAL_STRETCH_BLOCKED') {
      return 'This talent’s examination is Stretch-tier and cannot be submitted. Reach out to your manager if you believe this is incorrect.';
    }
    if (error.code === 'NOT_FOUND') {
      return 'The examination for this talent and requisition is missing or no longer active.';
    }
    if (error.code === 'IDEMPOTENCY_KEY_CONFLICT') {
      return 'This action conflicts with an earlier submittal. Refresh the page to see the current state.';
    }
    if (error.status === 403) {
      return 'You do not have permission to create a submittal.';
    }
  }
  return 'Submittal creation failed. Please try again.';
}

export function transitionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SUBMITTAL_STATE_INVALID') {
      return 'This transition is not allowed from the current state. Refresh the page.';
    }
    if (error.code === 'SUBMITTAL_ALREADY_CONFIRMED') {
      return 'This submittal has already been confirmed.';
    }
    if (error.code === 'IDEMPOTENCY_KEY_CONFLICT') {
      return 'This action conflicts with an earlier transition. Refresh the page.';
    }
    if (error.code === 'NOT_FOUND') {
      return 'This submittal is no longer visible.';
    }
    if (error.status === 403) {
      return 'You do not have permission to advance this submittal.';
    }
  }
  return 'The transition failed. Please try again.';
}

export function confirmErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ATTESTATION_MISSING') {
      return 'All three attestations must be checked before confirming.';
    }
    if (error.code === 'SUBMITTAL_STRETCH_BLOCKED') {
      return 'This examination is Stretch-tier and cannot be confirmed.';
    }
    if (error.code === 'EXAMINATION_PINNED_OUTDATED') {
      return 'A newer examination exists for this talent and job. Refresh and start a new submittal.';
    }
    if (error.code === 'JUSTIFICATION_REQUIRED') {
      return 'A justification is required for Worth Considering tier examinations.';
    }
  }
  return transitionErrorMessage(error);
}

export function revokeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'REVOKE_NOT_ALLOWED') {
      return 'This submittal cannot be revoked in its current state.';
    }
    if (error.code === 'NOT_FOUND') {
      return 'This submittal is no longer visible.';
    }
    if (error.status === 403) {
      return 'You do not have permission to revoke this submittal.';
    }
  }
  return 'Revoke failed. Please try again.';
}
