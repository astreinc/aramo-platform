import { ApiError } from '@aramo/fe-foundation';

// S5b precedent — surface the BE-typed code/details cleanly; never the
// raw `error.message` (which is the developer-facing version).

export function transitionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INVALID_PIPELINE_TRANSITION') {
      return 'That status change is not allowed from the current state.';
    }
    // L2-A — optimistic-concurrency conflict: someone else advanced this
    // pipeline since it was loaded. Prompt a refresh-and-retry.
    if (error.code === 'PIPELINE_TRANSITION_CONFLICT') {
      return 'This pipeline was just updated by someone else. Refresh and try again.';
    }
    // Talent Lifecycle R1–R5 Impl Directive v1.2 §2.4 / §4 — the Qualified RTR refusals and
    // the retryable transaction conflict, each with specific, honest copy.
    if (error.code === 'PIPELINE_QUALIFY_REQUIRES_RTR') {
      return 'This talent can’t be marked Qualified until the Right to Represent is signed for this requisition.';
    }
    if (error.code === 'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED') {
      return 'This talent can’t be marked Qualified yet: the Right to Represent policy isn’t set for this client. Ask an admin to set it.';
    }
    if (error.code === 'TRANSACTION_CONFLICT_RETRYABLE') {
      return 'Something changed at the same moment, so nothing was saved. Try again.';
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
