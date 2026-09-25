import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vitest hoists vi.mock above the imports (keeps the import group contiguous).
vi.mock('./offer-document-api', () => ({
  requestOfferDocument: vi.fn(),
  sendOfferDocument: vi.fn(),
  getOfferDocumentStatus: vi.fn(),
}));

import { OfferLetterPanel } from './OfferLetterPanel';
import { requestOfferDocument, sendOfferDocument, getOfferDocumentStatus } from './offer-document-api';

// DOC-6 (R-6-8) — the recruiter Offer Letter panel: request → send → derived status,
// and the intended dual state (Offer=SENT while Letter=Signed/Executed, PL-1).

describe('OfferLetterPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests, sends, and reflects the derived offer-letter status from the backend', async () => {
    vi.mocked(requestOfferDocument).mockResolvedValue({ document_id: 'doc-1', offer_id: 'o-1' });
    vi.mocked(sendOfferDocument).mockResolvedValue({ document_id: 'doc-1', envelope_id: 'env-1', status: 'SENT' });
    vi.mocked(getOfferDocumentStatus).mockResolvedValue({ document_id: 'doc-1', status: 'EXECUTED', document_status: 'EXECUTED' });

    render(<OfferLetterPanel offerId="o-1" offerState="SENT" />);

    fireEvent.click(screen.getByText('Request offer letter'));
    await waitFor(() => screen.getByText('Send for signature'));
    expect(requestOfferDocument).toHaveBeenCalledWith({ offer_id: 'o-1' });
    expect(screen.getByText('Preparing')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Send for signature'));
    await waitFor(() => screen.getByText('Awaiting signature'));
    expect(sendOfferDocument).toHaveBeenCalledWith('doc-1', 'o-1');

    fireEvent.click(screen.getByText('Refresh status'));
    await waitFor(() => screen.getByText('Signed / Executed'));
    expect(getOfferDocumentStatus).toHaveBeenCalledWith('doc-1');

    // PL-1 dual state: the Offer's own status is UNCHANGED (still SENT) while the
    // Offer Letter reads Signed / Executed.
    expect(screen.getByText('SENT')).toBeInTheDocument();
    // PL-5: no Copy-link / Resend action is rendered.
    expect(screen.queryByText(/Copy signing link/i)).toBeNull();
    expect(screen.queryByText(/Resend/i)).toBeNull();
    // Executed-view links appear only post-execution.
    expect(screen.getByText('View Executed Offer')).toBeInTheDocument();
    expect(screen.getByText('View Execution Certificate')).toBeInTheDocument();
  });

  it('surfaces a backend error', async () => {
    vi.mocked(requestOfferDocument).mockRejectedValue(new Error('offer o-1 not found'));
    render(<OfferLetterPanel offerId="o-1" offerState="SENT" />);
    fireEvent.click(screen.getByText('Request offer letter'));
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('offer o-1 not found');
  });
});
