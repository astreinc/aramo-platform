import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import { describeCalendarMeetingError } from './calendar-meeting-errors';

// M365-SCHED-1 PR 1B — governed, product-safe mapping of the backend scheduling
// error codes to FE copy + interaction affordances. Never surfaces raw `.message`.

function apiErr(code: string, status: number, details?: Record<string, unknown>): ApiError {
  return new ApiError(status, 'developer-facing raw message — must never be shown', code, details);
}

describe('describeCalendarMeetingError', () => {
  it('UNRESOLVED → not retryable, preserves operation reference, no "Outlook alone resolves" promise', () => {
    const r = describeCalendarMeetingError(
      apiErr('MICROSOFT_SCHEDULING_UNRESOLVED', 409, { operation_id: 'op-123' }),
    );
    expect(r.retryable).toBe(false);
    expect(r.operationReference).toBe('op-123');
    expect(r.message).toMatch(/could not be confirmed|uncertain|not confirmed/i);
    expect(r.message).not.toMatch(/raw message/i); // never the developer message
    // Must NOT promise that checking Outlook alone fixes Aramo's durable state.
    expect(r.message).not.toMatch(/check outlook (and )?(it|the meeting) will|will appear|automatically resolve/i);
    expect(r.message).toMatch(/support|operations|administrator/i);
  });

  it('VERSION_CONFLICT → retryable after refresh; copy says refresh', () => {
    const r = describeCalendarMeetingError(apiErr('MICROSOFT_MEETING_VERSION_CONFLICT', 409));
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/refresh|updated|again/i);
  });

  it('REAUTHORIZATION_REQUIRED → needsReconnect true', () => {
    const r = describeCalendarMeetingError(apiErr('MICROSOFT_REAUTHORIZATION_REQUIRED', 409));
    expect(r.needsReconnect).toBe(true);
    expect(r.message).toMatch(/connect|reconnect|authoriz/i);
  });

  it('CONSENT_DENIED → not retryable, explains contacting consent', () => {
    const r = describeCalendarMeetingError(apiErr('COMMUNICATION_MEETING_CONSENT_DENIED', 409));
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/consent|contact/i);
  });

  it('ASSOCIATION_INVALID → not retryable', () => {
    const r = describeCalendarMeetingError(apiErr('MICROSOFT_MEETING_ASSOCIATION_INVALID', 422));
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/not .*associated|requisition|pipeline/i);
  });

  it('IN_PROGRESS and IDEMPOTENCY_CONFLICT → not retryable (no blind re-send)', () => {
    expect(describeCalendarMeetingError(apiErr('MICROSOFT_SCHEDULING_IN_PROGRESS', 409)).retryable).toBe(false);
    expect(describeCalendarMeetingError(apiErr('MICROSOFT_SCHEDULING_IDEMPOTENCY_CONFLICT', 409)).retryable).toBe(false);
  });

  it('NOT_ORGANIZER (403) and NOT_FOUND (404) map by code', () => {
    expect(describeCalendarMeetingError(apiErr('MICROSOFT_MEETING_NOT_ORGANIZER', 403)).message).toMatch(/organizer|permission/i);
    expect(describeCalendarMeetingError(apiErr('MICROSOFT_MEETING_NOT_FOUND', 404)).message).toMatch(/no longer|not found|removed/i);
  });

  it('PROVIDER_ERROR (502) → retryable later', () => {
    const r = describeCalendarMeetingError(apiErr('MICROSOFT_PROVIDER_ERROR', 502));
    expect(r.message).toMatch(/microsoft|provider|temporar/i);
  });

  it('unknown / non-ApiError → safe fallback, not retryable-unsafe, never raw message', () => {
    const r = describeCalendarMeetingError(new Error('boom raw'));
    expect(r.message).not.toMatch(/boom raw/);
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.code).toBeNull();
  });
});
