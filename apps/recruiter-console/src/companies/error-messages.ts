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
