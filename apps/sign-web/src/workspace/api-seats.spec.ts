import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import { errorMessage, isSeatLimitReached, seatLimitMessage } from './api';
import { parseSeats, seatsUsedText } from './catalog';

// Sign Business per-seat directive (v1.0 LOCKED) §3.5.2 — a 409 seat_limit_reached wherever a member
// is added reads "All N seats are in use. Add a seat to invite more people."; the seat refusals of
// POST /v1/sign/billing/seats have their own words.

describe('per-seat refusal messages', () => {
  it('seat_limit_reached names the purchased seats', () => {
    const e = new ApiError(409, 'raw', 'TENANT_USER_CONFLICT', { reason: 'seat_limit_reached', used: 5, purchased: 5 });
    expect(isSeatLimitReached(e)).toBe(true);
    expect(errorMessage(e)).toBe('All 5 seats are in use. Add a seat to invite more people.');
    expect(seatLimitMessage(undefined)).toBe('All seats are in use. Add a seat to invite more people.');
    expect(isSeatLimitReached(new ApiError(409, 'raw', 'X', { reason: 'other' }))).toBe(false);
  });

  it('seats_below_usage, seats_not_applicable and seats_unchanged', () => {
    expect(errorMessage(new ApiError(409, 'raw', 'ESIGN_BILLING_CONFLICT', { reason: 'seats_below_usage', used: 2 }))).toBe(
      '2 people are using seats, so you need at least 2 seats. Remove someone’s Aramo Sign access first to go lower.',
    );
    expect(errorMessage(new ApiError(409, 'raw', 'ESIGN_BILLING_CONFLICT', { reason: 'seats_not_applicable' }))).toBe('Seats can’t be changed for this subscription.');
    expect(errorMessage(new ApiError(409, 'raw', 'ESIGN_BILLING_CONFLICT', { reason: 'seats_unchanged' }))).toBe('That’s already your number of seats.');
  });

  it('seat helpers', () => {
    expect(seatsUsedText(3, 5)).toBe('3 of 5 seats used');
    expect(seatsUsedText(1, 1)).toBe('1 of 1 seat used');
    expect(parseSeats('4', 3)).toBe(4);
    expect(parseSeats('2', 3)).toBeNull();
    expect(parseSeats('1001', 1)).toBeNull();
    expect(parseSeats('1.5', 1)).toBeNull();
    expect(parseSeats('0', 0)).toBeNull();
  });
});

// UAT DOC-04 — an envelope the caller cannot see never shows the raw server text (it names the id).
describe('envelope not found', () => {
  it('reads the same for absent and not-yours, without the id', () => {
    const msg = errorMessage(new ApiError(404, 'envelope f9f4d3a2-362e-42e4-80c2-1f3adbe5f411 not found', 'ENVELOPE_NOT_FOUND'));
    expect(msg).toBe('This envelope isn’t available. It may have been deleted, or you don’t have access to it.');
    expect(msg).not.toContain('f9f4d3a2');
  });
});

// UAT DOC-06 / C3 (audit row 29) — the storage refusal: one wording for Personal and Business
// (the app's, with a neutral destination), never the server's text.
describe('storage full', () => {
  it('Personal and Business read the same words', () => {
    const want = 'Your storage is full. Remove draft documents you no longer need, or see your plan settings for more storage.';
    window.history.pushState({}, '', '/personal/envelopes/new');
    expect(errorMessage(new ApiError(409, 'Your organization’s storage is full', 'ESIGN_STORAGE_QUOTA_EXCEEDED'))).toBe(want);
    window.history.pushState({}, '', '/sign/envelopes/new');
    expect(errorMessage(new ApiError(409, 'x', 'ESIGN_STORAGE_QUOTA_EXCEEDED'))).toBe(want);
  });

  it('an unmapped refusal never shows the server text (C3, directive §5)', () => {
    expect(errorMessage(new ApiError(400, 'recipient 2 needs a valid email (internal id 9f1)', 'VALIDATION_ERROR'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(new ApiError(400, 'x', 'VALIDATION_ERROR'), 'Couldn’t save.')).toBe('Couldn’t save.');
  });
});

// UAT SND-14 — a second reminder says when the next one can go.
describe('reminder cooldown', () => {
  it('a refused reminder names the time; the page knows the soonest time from the recipients', async () => {
    const { nextReminderAt } = await import('./api');
    const msg = errorMessage(new ApiError(429, 'x', 'ESIGN_REMINDER_NOT_ALLOWED', { reason: 'reminder_cooldown', retry_at: '2026-11-19T15:30:00Z' }));
    // C3 (audit row 8) — the app's words: why, then when.
    expect(msg).toMatch(/^This signer was reminded less than an hour ago\. You can send another reminder at .+\.$/);
    const now = new Date('2026-11-19T14:40:00Z');
    expect(nextReminderAt([{ can_remind: false, reminder_available_at: '2026-11-19T15:30:00Z' }, { can_remind: false, reminder_available_at: '2026-11-19T15:10:00Z' }], now)).toBe('2026-11-19T15:10:00Z');
    expect(nextReminderAt([{ can_remind: true, reminder_available_at: null }], now)).toBeNull();
    expect(nextReminderAt([{ can_remind: false, reminder_available_at: '2026-11-19T14:00:00Z' }], now)).toBeNull();
  });
});
