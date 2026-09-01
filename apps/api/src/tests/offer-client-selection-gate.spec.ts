import { describe, expect, it } from 'vitest';

import { OfferClientSelectionGate } from '../offer/offer-client-selection-gate.service.js';

// L3-E — SELECTED gates Offer creation. The gate reads THIS submittal's
// ClientSelectionProcess (exact authority chain) and permits Offer creation only when it
// is SELECTED; every other state — and a missing process — is refused deterministically
// with OFFER_CLIENT_SELECTION_NOT_SELECTED (409). No compatibility bypass.

function gateWith(state: string | null): OfferClientSelectionGate {
  const db = {
    $queryRawUnsafe: async () => (state === null ? [] : [{ state }]),
  };
  return new OfferClientSelectionGate(db as never);
}

const base = { tenant_id: 't-1', submittal_id: 's-1', requestId: 'r-1' };

describe('OfferClientSelectionGate (L3-E)', () => {
  it('permits Offer creation when the submittal-linked client-selection is SELECTED', async () => {
    await expect(gateWith('SELECTED').assertSelected(base)).resolves.toBeUndefined();
  });

  for (const state of ['CLIENT_REVIEW', 'INTERVIEW', 'DECLINED', 'WITHDRAWN']) {
    it(`refuses OFFER_CLIENT_SELECTION_NOT_SELECTED (409) when the client-selection is ${state}`, async () => {
      await expect(gateWith(state).assertSelected(base)).rejects.toMatchObject({
        code: 'OFFER_CLIENT_SELECTION_NOT_SELECTED',
        statusCode: 409,
      });
    });
  }

  it('refuses when NO client-selection exists for the submittal (no bypass)', async () => {
    await expect(gateWith(null).assertSelected(base)).rejects.toMatchObject({
      code: 'OFFER_CLIENT_SELECTION_NOT_SELECTED',
      statusCode: 409,
    });
  });
});
