import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { portalApi, type PortalDisputeListResponse } from '../portal-api';

import { DisputesListView } from './DisputesListView';

// Portal P3c (§PR-3) — the talent's disputes list. Covers the talent-visible
// lifecycle labels, the honest empty state, and the error path.

const LIST: PortalDisputeListResponse = {
  disputes: [
    {
      dispute_id: 'd1d1d1d1-d1d1-7d1d-8d1d-d1d1d1d1d1d1',
      status: 'UNDER_REVIEW',
      opened_at: '2026-07-10T00:00:00.000Z',
    },
    {
      dispute_id: 'd2d2d2d2-d2d2-7d2d-8d2d-d2d2d2d2d2d2',
      status: 'RESOLVED_CORRECTED',
      opened_at: '2026-06-01T00:00:00.000Z',
    },
  ],
};

function renderView() {
  return render(
    <MemoryRouter>
      <DisputesListView />
    </MemoryRouter>,
  );
}

describe('DisputesListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders disputes with talent-visible status labels', async () => {
    vi.spyOn(portalApi, 'listDisputes').mockResolvedValue(LIST);
    renderView();

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.getByText('Resolved — corrected')).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing is disputed', async () => {
    vi.spyOn(portalApi, 'listDisputes').mockResolvedValue({ disputes: [] });
    renderView();

    expect(
      await screen.findByText('You have not raised any disputes.'),
    ).toBeInTheDocument();
  });

  it('surfaces the api error honestly', async () => {
    vi.spyOn(portalApi, 'listDisputes').mockRejectedValue(
      new ApiError(500, 'boom', 'INTERNAL'),
    );
    renderView();

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
