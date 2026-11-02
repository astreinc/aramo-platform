import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import {
  createErrorMessage,
  lifecycleActionErrorMessage,
  updateErrorMessage,
} from './error-messages';

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

// ATS-QA-1 I-1 D9 — every hold/status refusal reason and a server fault map to their own copy;
// none falls to the generic "could not be completed" fallback.
describe('lifecycleActionErrorMessage — ATS-QA-1 D9 hold/status refusals + 5xx', () => {
  const GENERIC = 'The action could not be completed. Please try again.';
  const v = (reason: string, field?: string): ApiError =>
    new ApiError(400, 'Invalid hold details', 'VALIDATION_ERROR', field === undefined ? { reason } : { reason, field });

  it('hold_source_not_allowed', () => {
    expect(lifecycleActionErrorMessage(v('hold_source_not_allowed', 'source'))).toMatch(/Choose who placed the hold/);
  });
  it('hold_effective_at_invalid', () => {
    expect(lifecycleActionErrorMessage(v('hold_effective_at_invalid', 'effective_at'))).toMatch(/hold start date isn’t a valid date/);
  });
  it('hold_details_not_applicable', () => {
    expect(lifecycleActionErrorMessage(v('hold_details_not_applicable'))).toMatch(/only be added when putting the requisition on hold/);
  });
  it('version_required_for_status_change', () => {
    expect(lifecycleActionErrorMessage(v('version_required_for_status_change'))).toMatch(/out of date, so the status wasn’t changed/);
  });
  it('an untyped 400 validation refusal is not the generic fallback', () => {
    const msg = lifecycleActionErrorMessage(new ApiError(400, 'x', 'VALIDATION_ERROR'));
    expect(msg).toMatch(/weren’t accepted/);
    expect(msg).not.toBe(GENERIC);
  });
  it.each([500, 502, 503])('%s server fault → problem-on-our-side copy', (status) => {
    const msg = lifecycleActionErrorMessage(new ApiError(status, 'Internal error', 'INTERNAL_ERROR'));
    expect(msg).toMatch(/problem on our side/);
    expect(msg).not.toBe(GENERIC);
  });
  it('each reason has distinct copy', () => {
    const msgs = [
      'hold_details_required',
      'hold_source_not_allowed',
      'hold_effective_at_invalid',
      'hold_details_not_applicable',
      'version_required_for_status_change',
    ].map((r) => lifecycleActionErrorMessage(v(r)));
    expect(new Set(msgs).size).toBe(msgs.length);
  });
  it('a non-API error keeps the generic fallback', () => {
    expect(lifecycleActionErrorMessage(new Error('network'))).toBe(GENERIC);
  });
});

// CONTACTS-1 — a refused hiring-manager link reads as such on create + update.
describe('requisition create/update — contact link refusals', () => {
  it('CONTACT_DELETED', () => {
    const e = new ApiError(422, 'x', 'CONTACT_DELETED', { field: 'contact_id', contact_id: 'c' });
    expect(createErrorMessage(e)).toMatch(/has been deleted/);
    expect(updateErrorMessage(e)).toMatch(/has been deleted/);
  });
  it('contact_company_mismatch', () => {
    const e = new ApiError(422, 'x', 'VALIDATION_ERROR', { field: 'contact_id', reason: 'contact_company_mismatch' });
    expect(updateErrorMessage(e)).toMatch(/different company/);
  });
  it('contact_not_found', () => {
    const e = new ApiError(422, 'x', 'VALIDATION_ERROR', { field: 'contact_id', reason: 'contact_not_found' });
    expect(createErrorMessage(e)).toMatch(/could not be found/);
  });
});
