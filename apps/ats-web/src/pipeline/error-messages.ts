import { ApiError } from '@aramo/fe-foundation';

// S5b precedent — surface the BE-typed code/details cleanly; never the
// raw `error.message` (which is the developer-facing version).

export function transitionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INVALID_PIPELINE_TRANSITION') {
      return 'That status change is not allowed from the current state.';
    }
    if (error.code === 'REQUISITION_NO_OPENINGS') {
      return 'This requisition has no openings remaining. The transition to Placed was rejected.';
    }
    if (error.status === 403) {
      return 'You do not have permission to change this pipeline status.';
    }
    if (error.status === 404) {
      return 'This pipeline is no longer visible. It may have been removed or your access has changed.';
    }
  }
  return 'The status change failed. Please try again.';
}
