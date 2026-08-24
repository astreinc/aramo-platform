import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findSubmittalForTalentJob } from '../submittals/submittals-api';

import { OfferPanelContainer } from './OfferPanelContainer';
import { createOffer, listOffers, transitionOffer } from './offers-api';
import type { OfferState, OfferView } from './types';

vi.mock('./offers-api', () => ({
  listOffers: vi.fn(),
  createOffer: vi.fn(),
  transitionOffer: vi.fn(),
  readOffer: vi.fn(),
}));
vi.mock('../submittals/submittals-api', () => ({
  findSubmittalForTalentJob: vi.fn(),
}));

const offerIn = (state: OfferState): OfferView => ({
  id: 'o1',
  tenant_id: 'T',
  submittal_id: 's1',
  requisition_id: 'r1',
  talent_record_id: 't1',
  state,
  proposed_start_date: null,
  offer_expires_at: null,
  client_offer_reference: null,
  offer_terms_summary: null,
  decline_reason: null,
  created_at: '2026-08-01T00:00:00Z',
});

const ALL = ['offer:create', 'offer:transition'];

function renderC(scopes: readonly string[] = ALL): void {
  render(
    <OfferPanelContainer
      requisitionId="r1"
      talentRecordId="t1"
      scopes={scopes}
    />,
  );
}

describe('OfferPanelContainer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('discovers the live offer by (requisition, talent) and renders state + affordances', async () => {
    vi.mocked(listOffers).mockResolvedValue({ items: [offerIn('SENT')] });
    renderC();
    await waitFor(() =>
      expect(listOffers).toHaveBeenCalledWith({
        requisitionId: 'r1',
        talentRecordId: 't1',
      }),
    );
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(screen.getByText('Accept')).toBeTruthy(); // legal SENT affordance
  });

  it('prefers the LIVE (non-terminal) offer over an older terminal one', async () => {
    vi.mocked(listOffers).mockResolvedValue({
      items: [offerIn('DECLINED'), { ...offerIn('NEGOTIATION'), id: 'o2' }],
    });
    renderC();
    expect(await screen.findByText('In negotiation')).toBeTruthy();
  });

  it('PATCHes the affordance target on action, then reflects the new state', async () => {
    vi.mocked(listOffers).mockResolvedValue({ items: [offerIn('SENT')] });
    vi.mocked(transitionOffer).mockResolvedValue(offerIn('ACCEPTED'));
    renderC();
    fireEvent.click(await screen.findByText('Accept'));
    await waitFor(() =>
      expect(transitionOffer).toHaveBeenCalledWith('o1', { to_state: 'ACCEPTED' }),
    );
    expect(await screen.findByText('Accepted')).toBeTruthy();
    // terminal-success ⇒ no re-create affordance
    expect(screen.queryByText('Make offer')).toBeNull();
  });

  it('offers create when no offer exists; resolves submittal_id then POSTs', async () => {
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    vi.mocked(findSubmittalForTalentJob).mockResolvedValue({
      submittal: { id: 's9' } as never,
    });
    vi.mocked(createOffer).mockResolvedValue(offerIn('DRAFT'));
    renderC();
    fireEvent.click(await screen.findByText('Make offer'));
    await waitFor(() =>
      expect(findSubmittalForTalentJob).toHaveBeenCalledWith('t1', 'r1'),
    );
    await waitFor(() =>
      expect(createOffer).toHaveBeenCalledWith({
        submittal_id: 's9',
        requisition_id: 'r1',
        talent_record_id: 't1',
      }),
    );
    expect(await screen.findByText('Draft')).toBeTruthy();
  });

  it('create with no submittal shows the guard note and does NOT POST', async () => {
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    vi.mocked(findSubmittalForTalentJob).mockResolvedValue({ submittal: null });
    renderC();
    fireEvent.click(await screen.findByText('Make offer'));
    await waitFor(() =>
      expect(screen.getByText(/No submittal yet/)).toBeTruthy(),
    );
    expect(createOffer).not.toHaveBeenCalled();
  });

  it('an unsuccessful terminal (DECLINED) shows state for context AND allows a fresh offer', async () => {
    vi.mocked(listOffers).mockResolvedValue({ items: [offerIn('DECLINED')] });
    renderC();
    expect(await screen.findByText('Declined')).toBeTruthy();
    expect(screen.getByText('Make offer')).toBeTruthy();
  });

  it('without offer:create the container is inert — no read, nothing rendered', async () => {
    renderC([]);
    // give any (wrongly-issued) async read a tick to have fired
    await Promise.resolve();
    expect(listOffers).not.toHaveBeenCalled();
    expect(screen.queryByText('Make offer')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
  });
});
