import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { portalApi, type PortalVerificationsResponse } from '../portal-api';

import { VerificationsView } from './VerificationsView';

// Portal P3c (§PR-3) — the verification view + open-from-item. portalApi is
// stubbed at the method seam (P1 convention). Covers: trust-class rendering
// (kind + status + dates only), the open-from-item flow (opaque digest + UUID
// key + navigation to disputes), the honest empty state, and the error path.

const RESPONSE: PortalVerificationsResponse = {
  verifications: [
    {
      item_id: 'a'.repeat(64),
      kind: 'EMAIL',
      status: 'CONFIRMED',
      verified_at: '2026-06-01T00:00:00.000Z',
      first_seen_at: '2026-05-01T00:00:00.000Z',
    },
    {
      item_id: 'b'.repeat(64),
      kind: 'PHONE',
      status: 'PENDING',
      verified_at: null,
      first_seen_at: '2026-05-10T00:00:00.000Z',
    },
  ],
};

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/verifications']}>
      <Routes>
        <Route path="/verifications" element={<VerificationsView />} />
        <Route path="/disputes" element={<div>Disputes page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VerificationsView', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders trust-class items (kind + status + dates only)', async () => {
    vi.spyOn(portalApi, 'getVerifications').mockResolvedValue(RESPONSE);
    renderView();

    expect(await screen.findByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    // Every item offers a dispute action.
    expect(screen.getAllByRole('button', { name: 'Dispute this' })).toHaveLength(2);
  });

  it('open-from-item posts the opaque digest + UUID key, then navigates to disputes', async () => {
    vi.spyOn(portalApi, 'getVerifications').mockResolvedValue(RESPONSE);
    const open = vi.spyOn(portalApi, 'openDispute').mockResolvedValue({
      dispute_id: 'd1d1d1d1-d1d1-7d1d-8d1d-d1d1d1d1d1d1',
      status: 'OPEN',
      opened_at: '2026-07-16T00:00:00.000Z',
    });
    renderView();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Dispute this' }))[0]);
    fireEvent.change(screen.getByLabelText('What is wrong?'), {
      target: { value: 'This email is not mine.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open dispute' }));

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith(
      'a'.repeat(64),
      'This email is not mine.',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    // Navigates to the disputes list to show the new dispute.
    expect(await screen.findByText('Disputes page')).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing is verified', async () => {
    vi.spyOn(portalApi, 'getVerifications').mockResolvedValue({ verifications: [] });
    renderView();

    expect(
      await screen.findByText('Aramo has not verified anything about you yet.'),
    ).toBeInTheDocument();
  });

  it('surfaces the api error honestly', async () => {
    vi.spyOn(portalApi, 'getVerifications').mockRejectedValue(
      new ApiError(500, 'boom', 'INTERNAL'),
    );
    renderView();

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
