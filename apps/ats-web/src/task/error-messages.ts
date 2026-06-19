import { ApiError } from '@aramo/fe-foundation';

export function taskListErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'You do not have permission to view tasks.';
  }
  return 'Tasks could not be loaded. Please try again.';
}

// Create / edit. The create-time 404 (owner not visible) shouldn't happen
// from the UI (the owner is the in-context entity), but is surfaced honestly.
// The 422 assignee case (Ruling 5) gets a field-specific message the dialog
// renders inline on the assignee field.
export function taskMutateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to modify this task.';
    }
    if (error.status === 404) {
      return 'This record is no longer visible to you. The task was not saved.';
    }
    if (isAssigneeError(error)) {
      return 'That assignee is unavailable — pick an active user in this tenant.';
    }
    if (error.code === 'VALIDATION_ERROR') {
      return 'The task could not be saved — please check the fields and try again.';
    }
  }
  return 'The task failed to save. Please try again.';
}

// Ruling 5 — the 422 assignee surface. The BE returns VALIDATION_ERROR with
// details.reason='assignee_not_active_tenant_member'; the dialog renders this
// inline on the assignee field.
export function isAssigneeError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.details?.['reason'] === 'assignee_not_active_tenant_member'
  );
}
