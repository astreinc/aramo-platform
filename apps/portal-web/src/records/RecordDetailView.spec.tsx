import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { portalApi, type PortalRecordProfile } from '../portal-api';

import { RecordDetailView } from './RecordDetailView';

// Portal P1 PR-3 — the per-record profile view. portalApi.getRecordProfile rides
// apiClient → fetch; we stub it directly. Covers: the profile facts, and the
// uniform-404 path (an out-of-chain id renders an honest not-found notice).

const PROFILE: PortalRecordProfile = {
  talent_id: 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  tenant_status: 'active',
  source_channel: 'self_signup',
  created_at: '2026-05-01T12:00:00.000Z',
};

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/records/${id}`]}>
      <Routes>
        <Route path="/records/:id" element={<RecordDetailView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecordDetailView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the profile facts for a record in the chain', async () => {
    vi.spyOn(portalApi, 'getRecordProfile').mockResolvedValue(PROFILE);
    renderAt(PROFILE.talent_id);

    expect(await screen.findByText(PROFILE.tenant_id)).toBeInTheDocument();
    expect(screen.getByText('self_signup')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('renders an honest not-found notice for an out-of-chain (uniform 404) id', async () => {
    vi.spyOn(portalApi, 'getRecordProfile').mockRejectedValue(
      new ApiError(404, 'record not found', 'NOT_FOUND'),
    );
    renderAt('cccccccc-cccc-7ccc-8ccc-cccccccccccc');

    await waitFor(() =>
      expect(screen.getByText('record not found')).toBeInTheDocument(),
    );
  });
});
