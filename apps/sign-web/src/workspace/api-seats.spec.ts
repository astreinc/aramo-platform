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

// UAT DOC-06 — a Personal account's storage refusal has no organization / admin wording.
describe('storage full', () => {
  it('Personal workspace: its own words; Business keeps the organization words', async () => {
    const { inPersonalWorkspace, PERSONAL_STORAGE_FULL } = await import('./api');
    expect(inPersonalWorkspace('/personal/envelopes/x/edit')).toBe(true);
    expect(inPersonalWorkspace('/personalized')).toBe(false);
    expect(inPersonalWorkspace('/sign/envelopes')).toBe(false);
    window.history.pushState({}, '', '/personal/envelopes/new');
    expect(errorMessage(new ApiError(409, 'Your organization’s storage is full', 'ESIGN_STORAGE_QUOTA_EXCEEDED'))).toBe(PERSONAL_STORAGE_FULL);
    window.history.pushState({}, '', '/sign/envelopes/new');
    expect(errorMessage(new ApiError(409, 'x', 'ESIGN_STORAGE_QUOTA_EXCEEDED'))).toMatch(/^Your organization’s storage is full/);
  });
});

// UAT SND-14 — a second reminder says when the next one can go.
describe('reminder cooldown', () => {
  it('a refused reminder names the time; the page knows the soonest time from the recipients', async () => {
    const { nextReminderAt } = await import('./api');
    const msg = errorMessage(new ApiError(429, 'x', 'ESIGN_REMINDER_NOT_ALLOWED', { reason: 'reminder_cooldown', retry_at: '2026-11-19T15:30:00Z' }));
    expect(msg).toMatch(/^You can send another reminder at .+\.$/);
    const now = new Date('2026-11-19T14:40:00Z');
    expect(nextReminderAt([{ can_remind: false, reminder_available_at: '2026-11-19T15:30:00Z' }, { can_remind: false, reminder_available_at: '2026-11-19T15:10:00Z' }], now)).toBe('2026-11-19T15:10:00Z');
    expect(nextReminderAt([{ can_remind: true, reminder_available_at: null }], now)).toBeNull();
    expect(nextReminderAt([{ can_remind: false, reminder_available_at: '2026-11-19T14:00:00Z' }], now)).toBeNull();
  });
});
