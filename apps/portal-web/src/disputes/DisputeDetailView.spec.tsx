import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { portalApi, type PortalDisputeDetail } from '../portal-api';

import { DisputeDetailView } from './DisputeDetailView';

// Portal P3c (§PR-3) — one dispute's detail. Covers an open dispute (respond +
// withdraw available), the respond flow (append + UUID key + refetch), the
// withdraw flow (confirm + UUID key + refetch), and a resolved dispute (the
// plain-language resolution note is shown, no talent actions).

const ID = 'd1d1d1d1-d1d1-7d1d-8d1d-d1d1d1d1d1d1';

const OPEN_DISPUTE: PortalDisputeDetail = {
  dispute_id: ID,
  status: 'UNDER_REVIEW',
  opened_at: '2026-07-10T00:00:00.000Z',
  resolution_note: null,
  statements: [{ statement: 'This email is not mine.', created_at: '2026-07-10T00:00:00.000Z' }],
};

const RESOLVED_DISPUTE: PortalDisputeDetail = {
  dispute_id: ID,
  status: 'RESOLVED_CORRECTED',
  opened_at: '2026-07-10T00:00:00.000Z',
  resolution_note: 'We removed the incorrect email from your record.',
  statements: [{ statement: 'This email is not mine.', created_at: '2026-07-10T00:00:00.000Z' }],
};

function renderAt() {
  return render(
    <MemoryRouter initialEntries={[`/disputes/${ID}`]}>
      <Routes>
        <Route path="/disputes/:id" element={<DisputeDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DisputeDetailView', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders an open dispute with statements + respond/withdraw actions', async () => {
    vi.spyOn(portalApi, 'getDispute').mockResolvedValue(OPEN_DISPUTE);
    renderAt();

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.getByText('This email is not mine.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add response' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw dispute' })).toBeInTheDocument();
  });

  it('respond appends a statement with a UUID key and refetches', async () => {
    vi.spyOn(portalApi, 'getDispute').mockResolvedValue(OPEN_DISPUTE);
    const respond = vi.spyOn(portalApi, 'respondDispute').mockResolvedValue({
      dispute_id: ID,
      status: 'UNDER_REVIEW',
      opened_at: '2026-07-10T00:00:00.000Z',
    });
    renderAt();

    await screen.findByText('Under review');
    fireEvent.change(screen.getByLabelText('Add to your dispute'), {
      target: { value: 'Here is more detail.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add response' }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(
      ID,
      'Here is more detail.',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    // Immediate reflection: detail re-read (mount + post-respond refetch).
    expect(portalApi.getDispute).toHaveBeenCalledTimes(2);
  });

  it('withdraw confirms then calls withdraw with a UUID key and refetches', async () => {
    vi.spyOn(portalApi, 'getDispute').mockResolvedValue(OPEN_DISPUTE);
    const withdraw = vi.spyOn(portalApi, 'withdrawDispute').mockResolvedValue({
      dispute_id: ID,
      status: 'WITHDRAWN',
      opened_at: '2026-07-10T00:00:00.000Z',
    });
    renderAt();

    await screen.findByText('Under review');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw dispute' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));
    expect(withdraw).toHaveBeenCalledWith(
      ID,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(portalApi.getDispute).toHaveBeenCalledTimes(2);
  });

  it('shows the resolution note and no talent actions once resolved', async () => {
    vi.spyOn(portalApi, 'getDispute').mockResolvedValue(RESOLVED_DISPUTE);
    renderAt();

    expect(
      await screen.findByText('We removed the incorrect email from your record.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add response' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw dispute' })).not.toBeInTheDocument();
  });
});
