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
    // v1.2 §5 (A1 AM-1 §2.2) — the requisition's status does not permit this step.
    if (error.code === 'REQUISITION_NOT_ADVANCEABLE') {
      return 'This step isn’t available while the requisition is in its current status (for example closed, canceled, or a lead).';
    }
    if (error.code === 'TRANSACTION_CONFLICT_RETRYABLE') {
      return 'Something changed at the same moment, so nothing was saved. Try again.';
    }
    // Pipeline & RTR Recon Remediation Directive v1.0 R1 (DEF-5/DEF-6) — Not in consideration
    // needs a governed disposition with a reason, and is recorded once.
    if (error.code === 'PIPELINE_DISPOSITION_REASON_INVALID') {
      return 'Choose a reason to mark this talent Not in consideration.';
    }
    if (error.code === 'PIPELINE_ALREADY_DISPOSITIONED') {
      return 'This talent already has a recorded outcome on this requisition. Refresh to see it.';
    }
    if (error.code === 'REQUISITION_NO_OPENINGS') {
      return 'This requisition has no openings remaining.';
    }
    // Pipeline & RTR Recon Remediation Directive v1.0 R3 (DEF-14; A1-TE TE-6) — every refusal on
    // this path gets specific copy, never the generic failure.
    if (error.code === 'PIPELINE_STAGE_REQUIRES_EVIDENCE') {
      return 'This stage is set from a recorded contact or response, not moved by hand. Send the email or record the response instead.';
    }
    if (error.code === 'PIPELINE_EVIDENCE_INADMISSIBLE') {
      return 'This step needs a recorded contact or a confirmed response first.';
    }
    if (error.code === 'PIPELINE_COMPLETE_SYSTEM_ONLY') {
      return 'Completion is recorded automatically when the placement starts; it can’t be set by hand.';
    }
    if (error.code === 'VALIDATION_ERROR') {
      return 'Something in this request wasn’t accepted. Refresh and try again.';
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

// Pipeline & RTR Recon Remediation Directive v1.0 R3 (DEF-11, DEF-14) — the Add Talent refusals,
// shared by the requisition's Add Talent dialog and Talent 360's "Add to requisition". Each
// refusal says what happened; nothing reads as "added" unless the server created the episode.
export function addTalentErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PIPELINE_EPISODE_ALREADY_LIVE') {
      return 'This talent is already on this requisition.';
    }
    const reason = (error.details as { reason?: unknown; reason_code?: unknown } | undefined) ?? {};
    if (error.code === 'INSUFFICIENT_PERMISSIONS' && reason.reason === 'pipeline_re_add_requires_senior_role') {
      return 'This talent was on this requisition before. Only a Recruiter Lead, Recruiting Manager or admin can add them again.';
    }
    if (error.code === 'REQUISITION_NOT_ADVANCEABLE') {
      return 'Talent can’t be added while the requisition is in its current status (for example closed or canceled).';
    }
    if (error.code === 'POLICY_DENIED') {
      return 'The requisition’s rules don’t allow adding talent right now (for example, it is still a draft or awaiting approval).';
    }
    if (error.code === 'NOT_FOUND') {
      return 'That requisition or talent is no longer available to you.';
    }
    if (error.code === 'TRANSACTION_CONFLICT_RETRYABLE' || error.code === 'PIPELINE_TRANSITION_CONFLICT') {
      return 'Something changed at the same moment, so nothing was saved. Try again.';
    }
    if (error.status === 403) {
      return 'You don’t have permission to add talent to this requisition.';
    }
  }
  return 'Could not add this talent. Please try again.';
}
