import { ApiError } from '@aramo/fe-foundation';

export function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view companies.';
    }
  }
  return 'Companies could not be loaded.';
}

export function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view this company.';
    }
    if (error.status === 404) {
      return 'This company is not available.';
    }
  }
  return 'This company could not be loaded.';
}

export function contactsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view contacts.';
    }
  }
  return 'Contacts could not be loaded.';
}

export function reqsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view requisitions.';
    }
  }
  return 'Requisitions could not be loaded.';
}

// R6' — mutate-side error mapping. Surfaces ApiError.details.field
// where the BE returns it so the recruiter can fix the input. Same
// shape as R4's requisitions/error-messages.

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
      return 'You do not have permission to create companies.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The company could not be created — please check the form and try again.';
    }
  }
  return 'The company could not be created. Please try again.';
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to edit this company.';
    }
    if (error.status === 404) {
      return 'This company is no longer available.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The company could not be updated — please check the form and try again.';
    }
  }
  return 'The company could not be updated. Please try again.';
}
