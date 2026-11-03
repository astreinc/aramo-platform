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

// CONTACTS-1 — the contact-link refusals, shared by every surface that writes a
// contact reference (requisition hiring manager, company billing contact, task
// owner, reports-to, contact owner):
//   · 422 CONTACT_DELETED — the referenced contact has been deleted (SD-6).
//   · 422 VALIDATION_ERROR details.reason:
//       contact_not_found        — not a contact in this tenant
//       contact_company_mismatch — the contact is at a different company
//       owner_not_assignable     — the owner is not an active user here
// Returns null when the error is none of these, so callers fall through to
// their own mapping.
export function contactLinkErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'CONTACT_DELETED') {
    return 'That contact has been deleted, so it can’t be linked here. Choose another contact.';
  }
  if (error.code === 'VALIDATION_ERROR') {
    const reason = error.details?.['reason'];
    if (reason === 'contact_company_mismatch') {
      return 'That contact works at a different company. Choose a contact at this company.';
    }
    if (reason === 'contact_not_found') {
      return 'That contact could not be found. Choose another contact.';
    }
    if (reason === 'owner_not_assignable') {
      return 'That owner can’t be assigned. Choose an active user in your organization.';
    }
  }
  return null;
}

export function deleteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to delete contacts.';
    }
    if (error.status === 404) {
      return 'This contact is no longer available.';
    }
  }
  return 'The contact could not be deleted. Please try again.';
}

export function restoreErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to restore contacts.';
    }
    if (error.status === 404) {
      return 'This contact is no longer available.';
    }
  }
  return 'The contact could not be restored. Please try again.';
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
  const link = contactLinkErrorMessage(error);
  if (link !== null) return link;
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
  const link = contactLinkErrorMessage(error);
  if (link !== null) return link;
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
