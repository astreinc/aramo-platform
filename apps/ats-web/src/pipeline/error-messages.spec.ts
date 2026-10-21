import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { transitionErrorMessage } from './error-messages';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §2.4 — every new typed refusal on the
// Qualified path gets specific, honest recruiter copy (never the generic rejection).
describe('transitionErrorMessage (v1.2 §2.4)', () => {
  it('RTR required and not signed', () => {
    expect(transitionErrorMessage(new ApiError(422, 'x', 'PIPELINE_QUALIFY_REQUIRES_RTR'))).toMatch(
      /Right to Represent is signed/,
    );
  });

  it('RTR policy not set for the client (UNRESOLVED)', () => {
    expect(transitionErrorMessage(new ApiError(422, 'x', 'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED'))).toMatch(
      /policy isn’t set for this client/,
    );
  });

  it('retryable transaction conflict — nothing was saved', () => {
    expect(transitionErrorMessage(new ApiError(409, 'x', 'TRANSACTION_CONFLICT_RETRYABLE'))).toMatch(
      /nothing was saved/,
    );
  });

  it('requisition status does not permit the step (S2)', () => {
    expect(transitionErrorMessage(new ApiError(409, 'x', 'REQUISITION_NOT_ADVANCEABLE'))).toMatch(/isn’t available while the requisition/);
  });

  it('Not in consideration without a reason, and an already-recorded outcome (R1)', () => {
    expect(transitionErrorMessage(new ApiError(422, 'x', 'PIPELINE_DISPOSITION_REASON_INVALID'))).toMatch(/Choose a reason/);
    expect(transitionErrorMessage(new ApiError(409, 'x', 'PIPELINE_ALREADY_DISPOSITIONED'))).toMatch(/already has a recorded outcome/);
  });

  it('an unknown error keeps the generic fallback', () => {
    expect(transitionErrorMessage(new Error('boom'))).toBe('The status change failed. Please try again.');
  });
});
