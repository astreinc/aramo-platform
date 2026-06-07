import { ApiError } from '@aramo/fe-foundation';

export function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view requisitions.';
    }
  }
  return 'Requisitions could not be loaded.';
}

export function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This requisition is not available. It may have been removed or is not assigned to you.';
    }
    if (error.status === 403) {
      return 'You do not have permission to view this requisition.';
    }
  }
  return 'This requisition could not be loaded.';
}
