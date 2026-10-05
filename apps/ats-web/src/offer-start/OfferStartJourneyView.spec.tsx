import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTalentJourney, type TalentRequisitionJourney } from '../pipeline/talent-journey-api';
import { listOffers } from '../offers/offers-api';
import type { OfferView } from '../offers/types';

import { OfferStartJourneyView } from './OfferStartJourneyView';

// vitest hoists vi.mock above the imports above, so the named imports are the mocked fns.
vi.mock('../pipeline/talent-journey-api', () => ({ getTalentJourney: vi.fn() }));
vi.mock('../offers/offers-api', () => ({ listOffers: vi.fn() }));

function journey(sub: Record<string, string | null>, doc: TalentRequisitionJourney['offer_document'] = null): TalentRequisitionJourney {
  return {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: 'OFFER',
    stages: [],
    sub_states: { pipeline_stage: null, submittal_state: null, selection_state: 'SELECTED', interview_state: null, offer_state: null, placement_state: null, pre_start_state: null, assignment_state: null, ...sub },
    actions: [],
    offer_document: doc,
  };
}

const OFFER: OfferView = {
  id: 'o1', tenant_id: 'T', submittal_id: 's1', requisition_id: 'r1', talent_record_id: 't1',
  state: 'SENT', proposed_start_date: '2026-10-19', offer_expires_at: '2026-10-06',
  offer_terms_summary: 'Business Analyst', decline_reason: null, created_at: '2026-08-01T00:00:00Z',
} as OfferView;

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/offer-start/p1']}>
      <Routes>
        <Route path="offer-start/:pipelineId" element={<OfferStartJourneyView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OfferStartJourneyView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('composes the journey + offer by pipeline id; derived pill + documents + terms from server facts', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'SENT' }, { owner: 'documents', document_id: 'd1', status: 'AWAITING_SIGNATURE' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [OFFER] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('offer-start-journey')).toBeTruthy());
    // deep-link correctness: the read is keyed on the pipeline id from the route.
    expect(getTalentJourney).toHaveBeenCalledWith('p1');
    // derived pill (presentation of server state — not a stored status).
    expect(screen.getByTestId('os-pill').textContent).toBe('Awaiting signature');
    // Documents rail reflects the offer-letter DOCUMENT signal.
    expect(within(screen.getByTestId('os-doc-offer-letter')).getByText('Awaiting signature')).toBeTruthy();
    // Offer terms rail renders the authoritative talent-facing offer read.
    expect(within(screen.getByTestId('os-offer-terms')).getByText('2026-10-19')).toBeTruthy();
    // Happy path → no exceptions.
    expect(screen.queryByTestId('os-attn-offer_declined')).toBeNull();
  });

  it('declined offer → pill reflects it and Needs attention surfaces the exception', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'DECLINED' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-pill').textContent).toBe('Offer declined'));
    expect(screen.getByTestId('os-attn-offer_declined')).toBeTruthy();
  });
});
