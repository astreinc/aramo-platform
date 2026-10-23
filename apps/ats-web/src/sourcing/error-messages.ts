import { ApiError } from '@aramo/fe-foundation';

import type { SourcingStatus } from './types';

export function poolErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'You do not have permission to view the sourcing pool.';
  }
  return 'The sourcing pool could not be loaded.';
}

export function subjectErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This arrival is no longer in the sourcing pool.';
    }
    if (error.status === 403) {
      return 'You do not have permission to view this arrival.';
    }
  }
  return 'This arrival could not be loaded.';
}

export function promoteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return 'A talent with this email or cell phone already exists. It has been flagged for identity review.';
    }
    if (error.status === 403) {
      return 'You do not have permission to promote from the sourcing pool.';
    }
    if (error.status === 404) {
      return 'This arrival or requisition is no longer available.';
    }
  }
  return 'That action could not be completed. Please try again.';
}

export function advisoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to resolve identity advisories.';
    }
    if (error.status === 409 || error.status === 400) {
      return 'This advisory has already been resolved, or the input was rejected.';
    }
  }
  return 'The advisory could not be resolved. Please try again.';
}

// A deferral is an EXPECTED outcome, not an error: the promote was declined by
// the identity gate. Each maps to plain-language guidance (never a raw enum).
// deferred_unresolved_identity additionally steers to the advisory-resolve step.
export function deferralGuidance(status: SourcingStatus): string {
  switch (status) {
    case 'deferred_unresolved_identity':
      return 'Resolve the pending identity flag below before promoting this arrival.';
    case 'deferred_no_name':
      return 'This arrival has no first and last name yet, so it can’t be promoted.';
    case 'deferred_incomplete_contact':
      return 'This arrival needs both an email and a cell phone before it can be promoted.';
    case 'deferred_no_basis':
      return 'This arrival has no recorded source to promote from.';
    case 'deferred_unknown_subject':
      return 'This arrival could not be found. Refresh the pool and try again.';
    default:
      return 'This subject can’t be promoted yet.';
  }
}
