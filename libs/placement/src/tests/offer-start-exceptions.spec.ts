import { describe, expect, it } from 'vitest';

import { deriveOfferStartExceptions } from '../lib/offer-start-exceptions.js';

// Canonical live offer-start exceptions (offer expired/declined, pre-start blocked).
describe('deriveOfferStartExceptions', () => {
  it('no exceptions on a live/accepted/normal journey', () => {
    expect(deriveOfferStartExceptions({ offer_state: 'SENT', placement_state: null })).toEqual([]);
    expect(deriveOfferStartExceptions({ offer_state: 'ACCEPTED', placement_state: 'PRE_START' })).toEqual([]);
    expect(deriveOfferStartExceptions({ offer_state: null, placement_state: 'READY_TO_START' })).toEqual([]);
  });

  it('offer EXPIRED → offer_expired exception', () => {
    const [e] = deriveOfferStartExceptions({ offer_state: 'EXPIRED', placement_state: null });
    expect(e).toMatchObject({ kind: 'offer_expired', label: 'Offer expired' });
  });

  it('offer DECLINED → offer_declined exception', () => {
    const [e] = deriveOfferStartExceptions({ offer_state: 'DECLINED', placement_state: null });
    expect(e).toMatchObject({ kind: 'offer_declined', label: 'Offer declined' });
  });

  it('placement BLOCKED → pre_start_blocked exception', () => {
    const [e] = deriveOfferStartExceptions({ offer_state: null, placement_state: 'BLOCKED' });
    expect(e).toMatchObject({ kind: 'pre_start_blocked', label: 'Pre-start blocked' });
  });

  it('offer EXPIRED + placement BLOCKED → both, offer first', () => {
    const r = deriveOfferStartExceptions({ offer_state: 'EXPIRED', placement_state: 'BLOCKED' });
    expect(r.map((e) => e.kind)).toEqual(['offer_expired', 'pre_start_blocked']);
  });
});
