import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { lifecycleActionErrorMessage } from './error-messages';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.2 (S3) — the hold refusals get specific
// recruiter copy, never the generic failure.
describe('lifecycleActionErrorMessage — S3 hold copy', () => {
  it('missing hold details', () => {
    const err = new ApiError(400, 'x', 'VALIDATION_ERROR', { reason: 'hold_details_required' });
    expect(lifecycleActionErrorMessage(err)).toMatch(/Add a reason and who placed the hold/);
  });

  it('retryable transaction conflict — nothing was saved', () => {
    expect(lifecycleActionErrorMessage(new ApiError(409, 'x', 'TRANSACTION_CONFLICT_RETRYABLE'))).toMatch(/nothing was saved/);
  });
});
