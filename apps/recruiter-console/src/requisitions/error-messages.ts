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

// R4 — mutate-side error mapping. Surfaces ApiError.details.field where
// the BE returns it (compensation-validation.ts puts the offending field
// in details.field) so the recruiter can fix the input.

interface ApiErrorWithDetails {
  readonly details?: { readonly field?: string } | undefined;
}

function fieldFromError(error: ApiError): string | undefined {
  const det = (error as unknown as ApiErrorWithDetails).details;
  return det?.field;
}

export function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to create requisitions.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The requisition could not be created — please check the form and try again.';
    }
  }
  return 'The requisition could not be created. Please try again.';
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to edit this requisition.';
    }
    if (error.status === 404) {
      return 'This requisition is no longer available.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The requisition could not be updated — please check the form and try again.';
    }
  }
  return 'The requisition could not be updated. Please try again.';
}
