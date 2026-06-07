import { ApiError } from '@aramo/fe-foundation';

export function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view talent.';
    }
  }
  return 'Talent could not be loaded.';
}

export function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this talent record.';
    }
    if (error.status === 404) {
      return 'This talent record is not available.';
    }
  }
  return 'This talent record could not be loaded.';
}

export function attachmentsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view attachments.';
    }
  }
  return 'Attachments could not be loaded.';
}

export function pipelinesErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view pipelines.';
    }
  }
  return 'Pipelines could not be loaded.';
}
