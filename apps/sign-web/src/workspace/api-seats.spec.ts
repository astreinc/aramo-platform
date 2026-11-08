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
