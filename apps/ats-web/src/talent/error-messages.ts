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

// R5 — mutate-side error mapping. Surfaces ApiError.details.field when
// the BE returns it (the R4 pattern) so the recruiter can fix the input.

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
      return 'You do not have permission to create talent records.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The talent record could not be created — please check the form and try again.';
    }
  }
  return 'The talent record could not be created. Please try again.';
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to edit this talent record.';
    }
    if (error.status === 404) {
      return 'This talent record is no longer available.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The talent record could not be updated — please check the form and try again.';
    }
  }
  return 'The talent record could not be updated. Please try again.';
}

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to upload résumés.';
    }
    if (error.status === 413) {
      return 'The file is too large to upload.';
    }
  }
  return 'The résumé upload failed. Please try again.';
}

export function attachErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'The talent was saved, but attaching the résumé failed (no permission).';
    }
  }
  return 'The talent was saved, but attaching the résumé failed. You can re-attach it later from the detail page.';
}
