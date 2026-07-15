import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { portalApi, type PortalRecordProfile } from '../portal-api';

import { RecordsListView } from './RecordsListView';

// Portal P1 PR-3 — the records list (engagement surface). portalApi.listRecords
// rides apiClient → fetch; we stub it directly. Covers: populated rows + detail
// links, the honest empty state, and the error path.

const REC_A: PortalRecordProfile = {
  talent_id: 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  tenant_status: 'active',
  source_channel: 'self_signup',
  created_at: '2026-05-01T12:00:00.000Z',
};
const REC_B: PortalRecordProfile = {
  talent_id: 'b1b1b1b1-b1b1-7b1b-8b1b-b1b1b1b1b1b1',
  tenant_id: '22222222-2222-7222-8222-222222222222',
  tenant_status: 'active',
  source_channel: 'referral',
  created_at: '2026-05-02T12:00:00.000Z',
};
const RECORDS: PortalRecordProfile[] = [REC_A, REC_B];

function renderView() {
  return render(
    <MemoryRouter>
      <RecordsListView />
    </MemoryRouter>,
  );
}

describe('RecordsListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders each record with a detail link', async () => {
    vi.spyOn(portalApi, 'listRecords').mockResolvedValue({ records: RECORDS });
    renderView();

    const first = await screen.findByRole('link', { name: REC_A.tenant_id });
    expect(first).toHaveAttribute('href', `/records/${REC_A.talent_id}`);
    expect(
      screen.getByRole('link', { name: REC_B.tenant_id }),
    ).toHaveAttribute('href', `/records/${REC_B.talent_id}`);
    expect(screen.getByText('self_signup')).toBeInTheDocument();
  });

  it('shows an honest empty state for a portal user with no records', async () => {
    vi.spyOn(portalApi, 'listRecords').mockResolvedValue({ records: [] });
    renderView();

    expect(
      await screen.findByText('You have no records on Aramo yet.'),
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    vi.spyOn(portalApi, 'listRecords').mockRejectedValue(new Error('boom'));
    renderView();

    await waitFor(() =>
      expect(
        screen.getByText('Failed to load your records.'),
      ).toBeInTheDocument(),
    );
  });
});
