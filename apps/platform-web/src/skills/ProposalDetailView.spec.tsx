import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { skillsApi, type Proposal } from './skills-api';
import { ProposalDetailView } from './ProposalDetailView';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

const PENDING: Proposal = {
  id: 'p1', proposal_type: 'ALIAS', source: 'AI_RECOMMENDED', status: 'PENDING',
  payload: { skill_id: 's1', alias: 'K8s', alias_type: 'ABBREVIATION' },
  proposed_by: null, proposed_at: '2026-09-18T00:00:00.000Z',
  decided_by: null, decided_at: null, decision_reason: null, applied_entity_id: null,
};
const ACCEPTED: Proposal = { ...PENDING, status: 'ACCEPTED', applied_entity_id: 'a1', decided_at: '2026-09-18T01:00:00.000Z' };

function renderDetail(scopes: string[]) {
  return render(
    <MemoryRouter initialEntries={['/skills/proposals/p1']}>
      <ToastProvider>
        <Routes>
          <Route path="/skills/proposals/:id" element={<ProposalDetailView session={platformSession(scopes)} />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ProposalDetailView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers accept/reject for a PENDING proposal with manage scope', async () => {
    vi.spyOn(skillsApi, 'getProposal').mockResolvedValue(PENDING);
    renderDetail(MANAGE);
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('hides decision controls for read-only scope', async () => {
    vi.spyOn(skillsApi, 'getProposal').mockResolvedValue(PENDING);
    renderDetail(READ_ONLY);
    await waitFor(() => expect(screen.getByText(/Proposal —/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only \(platform:skill:manage required to decide\)/)).toBeInTheDocument();
  });

  it('renders a terminal (non-PENDING) proposal without decision controls', async () => {
    vi.spyOn(skillsApi, 'getProposal').mockResolvedValue(ACCEPTED);
    renderDetail(MANAGE);
    await waitFor(() => expect(screen.getByText(/no further decision is possible/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('on a 409 not-pending, refreshes from the server and shows the terminal state', async () => {
    // First load PENDING; accept 409s; the view reloads and the server now returns ACCEPTED.
    const get = vi
      .spyOn(skillsApi, 'getProposal')
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValue(ACCEPTED);
    vi.spyOn(skillsApi, 'acceptProposal').mockRejectedValue(
      new ApiError(409, 'not pending', 'SKILL_PROPOSAL_NOT_PENDING'),
    );

    renderDetail(MANAGE);
    const acceptBtn = await screen.findByRole('button', { name: 'Accept' });
    fireEvent.click(acceptBtn);

    await waitFor(() => expect(screen.getByText(/no further decision is possible/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2); // initial + terminal refresh
  });
});
