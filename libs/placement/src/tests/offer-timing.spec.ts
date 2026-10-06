import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OFFER_EXPIRY_WARNING_DAYS,
  EXPIRABLE_OFFER_STATES,
  deriveOfferTiming,
} from '../lib/offer-timing.js';

// Canonical offer-timing. Civil-day window in the app timezone; expirable states
// derived from the lifecycle EXPIRE edge ({ SENT, NEGOTIATION }). "Expired state"
// (OfferState EXPIRED) is a SEPARATE recorded fact, not this helper.
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-05T16:00:00Z'); // Oct 5 12:00 EDT
const atDaysAhead = (n: number): string =>
  new Date(Date.parse('2026-10-05T12:00:00-04:00') + n * 86_400_000).toISOString();

describe('EXPIRABLE_OFFER_STATES', () => {
  it('is exactly { SENT, NEGOTIATION } (derived from the EXPIRE edge)', () => {
    expect([...EXPIRABLE_OFFER_STATES].sort()).toEqual(['NEGOTIATION', 'SENT']);
    expect(DEFAULT_OFFER_EXPIRY_WARNING_DAYS).toBe(7);
  });
});

describe('deriveOfferTiming', () => {
  const t = (state: string, offer_expires_at: string | null) =>
    deriveOfferTiming({ state, offer_expires_at, now_ms: NOW, time_zone: TZ });

  it('no expiry on an awaiting-response offer → awaiting, not expiring, null days', () => {
    expect(t('SENT', null)).toEqual({
      awaiting_response: true,
      expiring_soon: false,
      expired_by_time: false,
      days_until_expiry: null,
    });
  });

  it('outside the warning window → not expiring', () => {
    const r = t('SENT', atDaysAhead(10));
    expect(r.expiring_soon).toBe(false);
    expect(r.expired_by_time).toBe(false);
    expect(r.days_until_expiry).toBe(10);
  });

  it('inside the warning window → expiring soon', () => {
    const r = t('NEGOTIATION', atDaysAhead(3));
    expect(r.expiring_soon).toBe(true);
    expect(r.days_until_expiry).toBe(3);
  });

  it('exactly on the warning boundary (7 days) → expiring soon (inclusive)', () => {
    const r = t('SENT', atDaysAhead(7));
    expect(r.expiring_soon).toBe(true);
    expect(r.days_until_expiry).toBe(7);
  });

  it('expiry on a prior civil day → expired_by_time, not expiring', () => {
    const r = t('SENT', atDaysAhead(-1));
    expect(r.expired_by_time).toBe(true);
    expect(r.expiring_soon).toBe(false);
    expect(r.days_until_expiry).toBe(-1);
  });

  it('same civil day (later today) is still expiring, not yet expired', () => {
    const r = t('SENT', atDaysAhead(0));
    expect(r.expired_by_time).toBe(false);
    expect(r.expiring_soon).toBe(true);
    expect(r.days_until_expiry).toBe(0);
  });

  it('non-expirable states (DRAFT/ACCEPTED/DECLINED/EXPIRED/RESCINDED) are never timed', () => {
    for (const s of ['DRAFT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED', null]) {
      expect(deriveOfferTiming({ state: s, offer_expires_at: atDaysAhead(2), now_ms: NOW, time_zone: TZ })).toEqual({
        awaiting_response: false,
        expiring_soon: false,
        expired_by_time: false,
        days_until_expiry: null,
      });
    }
  });
});
