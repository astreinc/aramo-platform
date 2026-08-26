import { ApiError } from '@aramo/fe-foundation';

export function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view requisitions.';
    }
  }
  return 'Requisitions could not be loaded.';
}

export function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This requisition is not available. It may have been removed or is not assigned to you.';
    }
    if (error.status === 403) {
      return 'You do not have permission to view this requisition.';
    }
  }
  return 'This requisition could not be loaded.';
}

// R4 — mutate-side error mapping. Surfaces ApiError.details.field where
// the BE returns it (compensation-validation.ts puts the offending field
// in details.field) so the recruiter can fix the input.

interface ApiErrorWithDetails {
  readonly details?:
    | { readonly field?: string; readonly reason?: string; readonly status?: string }
    | undefined;
}

function fieldFromError(error: ApiError): string | undefined {
  const det = (error as unknown as ApiErrorWithDetails).details;
  return det?.field;
}

function reasonFromError(error: ApiError): string | undefined {
  const det = (error as unknown as ApiErrorWithDetails).details;
  return det?.reason;
}

export function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to create requisitions.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The requisition could not be created — please check the form and try again.';
    }
  }
  return 'The requisition could not be created. Please try again.';
}

// New Requisition AI intake (charter §7.3) — the DRAFT-step error message.
// A draft failure is NOT a create failure; the copy says so and steers the
// recruiter to the always-available manual lane. AI_PROVIDER_UNAVAILABLE /
// AI_RATE_LIMITED are the honest codes the intake endpoint returns when the
// provider (or its out-of-band key) is unavailable.
export function intakeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_RATE_LIMITED' || error.status === 429) {
      return 'AI drafting is busy right now — try again in a moment, or enter the requisition manually.';
    }
    if (
      error.code === 'AI_PROVIDER_UNAVAILABLE' ||
      error.status === 502 ||
      error.status === 503
    ) {
      return 'AI drafting is unavailable right now. You can enter the requisition manually.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      return 'That intake text couldn’t be used — try a shorter note, or enter the requisition manually.';
    }
    if (error.status === 403) {
      return 'You do not have permission to use AI drafting.';
    }
  }
  return 'Couldn’t draft from your notes. You can enter the requisition manually.';
}

// L1-E — the named-lifecycle-action error map. A governed transition (Submit /
// Approve / Reject / Close / Reopen / Hold / Cancel / Close submittals) fires a
// status-changing PATCH; the BE is authoritative and can refuse for reasons the
// cosmetic affordance cannot pre-empt. This maps each TYPED refusal to specific,
// honest copy so none collapses to the generic fallback:
//   · 409 REQUISITION_VERSION_CONFLICT — a concurrent edit moved the row on.
//   · 422 REQUISITION_STATUS_GATED — the transition is illegal from the current
//     status (the affordance was stale, or the row changed underneath).
//   · 403 self-approval (details.reason=requisition_self_approval_forbidden) —
//     the SoD line (a submitter cannot approve their own requisition).
//   · 403 scope-missing (details.reason=requisition_approve_scope_missing).
//   · 403 POLICY_DENIED (or any other 403) — the policy engine denied the action.
export function lifecycleActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 || error.code === 'REQUISITION_VERSION_CONFLICT') {
      return 'This requisition changed since you loaded it. Reload and try the action again.';
    }
    if (error.status === 422 || error.code === 'REQUISITION_STATUS_GATED') {
      return 'That action is not available from the requisition’s current status. Reload to see the current options.';
    }
    if (error.status === 403) {
      const reason = reasonFromError(error);
      if (reason === 'requisition_self_approval_forbidden') {
        return 'You submitted this requisition for approval. Another approver is required.';
      }
      if (reason === 'requisition_approve_scope_missing') {
        return 'You do not have permission to approve or reject this requisition.';
      }
      // POLICY_DENIED and any other 403 — the backend policy engine refused.
      return 'That action was not permitted for this requisition.';
    }
    if (error.status === 404) {
      return 'This requisition is no longer available.';
    }
  }
  return 'The action could not be completed. Please try again.';
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to edit this requisition.';
    }
    if (error.status === 404) {
      return 'This requisition is no longer available.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      const field = fieldFromError(error);
      if (field !== undefined && field !== '') {
        return `The field "${field}" has an invalid value. Please check and try again.`;
      }
      return 'The requisition could not be updated — please check the form and try again.';
    }
  }
  return 'The requisition could not be updated. Please try again.';
}
