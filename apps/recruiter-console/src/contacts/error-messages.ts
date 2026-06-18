import { ApiError } from '@aramo/fe-foundation';

// R6' — contact mutate/error mapping. Mirrors the requisitions +
// companies pattern: surface ApiError.details.field where the BE
// returns it so the recruiter can fix the input.

interface ApiErrorWithDetails {
  readonly details?: { readonly field?: string } | undefined;
}

function fieldFromError(error: ApiError): string | undefined {
  const det = (error as unknown as ApiErrorWithDetails).details;
  return det?.field;
}

export function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view contacts.';
    }
  }
  return 'Contacts could not be loaded.';
}

export function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this contact.';
    }
    if (error.status === 404) {
      return 'This contact is not available.';
    }
  }
  return 'This contact could not be loaded.';
}

export function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to create contacts.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The contact could not be created — please check the form and try again.';
    }
  }
  return 'The contact could not be created. Please try again.';
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to edit this contact.';
    }
    if (error.status === 404) {
      return 'This contact is no longer available.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The contact could not be updated — please check the form and try again.';
    }
  }
  return 'The contact could not be updated. Please try again.';
}
