import { ApiError } from '@aramo/fe-foundation';

export function noteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to log notes on this requisition.';
    }
    if (error.status === 404) {
      return 'This requisition is no longer visible. The note was not saved.';
    }
    if (error.code === 'VALIDATION_ERROR') {
      return 'The note could not be saved — please check the content and try again.';
    }
  }
  return 'The note failed to save. Please try again.';
}

export function timelineErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this activity timeline.';
    }
  }
  return 'The activity timeline could not be loaded.';
}
