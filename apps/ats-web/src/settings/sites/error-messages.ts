import { ApiError } from '@aramo/fe-foundation';

// Settings Rebuild Directive 4 — legible messages for the sites surface.
//
// The backend raises 400 VALIDATION_ERROR / 404 NOT_FOUND with a precise
// details.reason; this maps each to operator-facing copy. An unmapped reason
// falls back to the server message.

export function messageForSiteError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : 'Something went wrong.';
  }
  const reason =
    typeof err.details?.['reason'] === 'string'
      ? (err.details['reason'] as string)
      : '';
  switch (reason) {
    case 'name_required':
      return 'A branch name is required.';
    case 'name_taken':
      return 'A branch with this name already exists in this tenant.';
    case 'too_long':
      return 'That value is too long.';
    case 'invalid_parent_id':
      return 'The selected parent branch is not valid.';
    case 'parent_not_found':
      return 'The selected parent branch does not exist in this tenant.';
    case 'parent_inactive':
      return 'The selected parent branch is deactivated — reactivate it first.';
    case 'parent_self':
      return 'A branch cannot be its own parent.';
    case 'parent_cycle':
      return 'That parent would create a loop in the branch hierarchy.';
    case 'too_deep':
      return 'That move would nest the branch hierarchy too deeply.';
    case 'site_in_use':
      return 'This branch is in use (it has members or child branches) — deactivate it instead of deleting.';
    case 'unknown_field':
      return 'That field cannot be edited here.';
    default:
      return err.message || 'Failed to save the branch.';
  }
}

// The site_in_use guard is the one a DELETE surfaces; callers special-case it
// to steer the operator to deactivate.
export function isSiteInUse(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.details?.['reason'] === 'string' &&
    err.details['reason'] === 'site_in_use'
  );
}
