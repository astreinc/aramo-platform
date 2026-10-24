import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it, vi } from 'vitest';

import { skillsApi, type Proposal } from './skills-api';
import { ProposalDetailView } from './ProposalDetailView';
import { ProposalsListView } from './ProposalsListView';
import { K8S, mockDirectory, proposal } from './skill-fixtures';
import { MANAGE, READ_ONLY, platformSession } from './test-session';

const P1 = proposal('p1');
const P2 = proposal('p2', {
  proposal_type: 'RELATIONSHIP',
  payload: { source_skill_id: 's-kube', target_skill_id: 's-terr', relationship_type: 'RELATED_TO', source: 'AI_RECOMMENDED' },
});
const P3 = proposal('p3', { status: 'REJECTED', decision_reason: 'Too ambiguous to map.' });

function mockList(proposals: Proposal[]) {
  return vi.spyOn(skillsApi, 'listProposals').mockResolvedValue({ proposals });
}

function renderAt(path: string, scopes: string[]) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/skills/proposals" element={<ProposalsListView />} />
        <Route path="/skills/proposals/:id" element={<ProposalDetailView session={platformSession(scopes)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Proposals', () => {
  it('Pending is the default filter, with counts; the list route opens the first proposal', async () => {
    mockDirectory();
    mockList([P1, P2, P3]);
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [K8S] });
    renderAt('/skills/proposals', MANAGE);
    const group = await screen.findByRole('group', { name: 'Status' });
    await waitFor(() => expect(within(group).getByRole('button', { name: /Pending/ })).toHaveTextContent('Pending2'));
    expect(within(group).getByRole('button', { name: /Pending/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /Rejected/ })).toHaveTextContent('Rejected1');
    expect(within(group).getByRole('button', { name: /All/ })).toHaveTextContent('All3');
    expect(await screen.findByRole('heading', { name: 'Alias proposal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /“k8s admin” → Kubernetes/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Kubernetes ↔ Terraform')).toBeInTheDocument();
    expect(screen.queryByText('Too ambiguous to map.')).not.toBeInTheDocument();
  });

  it('renders the proposed change as a human diff, not JSON', async () => {
    mockDirectory();
    mockList([P1]);
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [K8S] });
    renderAt('/skills/proposals/p1', MANAGE);
    const diff = await screen.findByRole('list', { name: 'Aliases of Kubernetes' });
    const items = within(diff).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-kind'))).toEqual(['same', 'added']);
    expect(items[1]).toHaveTextContent('k8s admin');
    expect(items[1]).toHaveTextContent('Common name');
    expect(screen.queryByText(/"skill_id"/)).not.toBeInTheDocument();
    expect(screen.getByText(/AI recommended · proposed 22 Oct 2026/)).toBeInTheDocument();
  });

  it('Accept and apply / Reject… only while Pending, and only with :manage', async () => {
    mockDirectory();
    mockList([P1, P3]);
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [] });
    const view = renderAt('/skills/proposals/p1', READ_ONLY);
    expect(await screen.findByText(/Deciding proposals needs the/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and apply' })).not.toBeInTheDocument();
    view.unmount();

    renderAt('/skills/proposals/p3?status=REJECTED', MANAGE);
    expect(await screen.findByText('Rejection reason: Too ambiguous to map.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject…' })).not.toBeInTheDocument();
  });

  it('accept applies, toasts and refreshes', async () => {
    mockDirectory();
    const list = mockList([P1]);
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [] });
    const accept = vi.spyOn(skillsApi, 'acceptProposal').mockResolvedValue({ ...P1, status: 'ACCEPTED' });
    renderAt('/skills/proposals/p1', MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept and apply' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('409 SKILL_PROPOSAL_NOT_PENDING → the warning alert, and the list is refreshed', async () => {
    mockDirectory();
    const list = vi
      .spyOn(skillsApi, 'listProposals')
      .mockResolvedValueOnce({ proposals: [P1] })
      .mockResolvedValue({ proposals: [{ ...P1, status: 'ACCEPTED' }] });
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [] });
    vi.spyOn(skillsApi, 'acceptProposal').mockRejectedValue(
      new ApiError(409, 'not pending', 'SKILL_PROPOSAL_NOT_PENDING'),
    );
    renderAt('/skills/proposals/p1', MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept and apply' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This proposal is no longer pending — it was accepted by another operator a moment ago. The list has been refreshed. (SKILL_PROPOSAL_NOT_PENDING)',
    );
    expect(alert).toHaveClass('pw-alert--warn');
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Accept and apply' })).not.toBeInTheDocument();
  });

  it('reject sends the optional reason; a 409 there closes the dialog and shows the alert', async () => {
    mockDirectory();
    vi.spyOn(skillsApi, 'listProposals')
      .mockResolvedValueOnce({ proposals: [P1] })
      .mockResolvedValue({ proposals: [{ ...P1, status: 'REJECTED' }] });
    vi.spyOn(skillsApi, 'listAliases').mockResolvedValue({ aliases: [] });
    const reject = vi
      .spyOn(skillsApi, 'rejectProposal')
      .mockRejectedValue(new ApiError(409, 'not pending', 'SKILL_PROPOSAL_NOT_PENDING'));
    renderAt('/skills/proposals/p1', MANAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Duplicate' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith('p1', { reason: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('it was rejected by another operator');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('an unreadable payload shows plain copy, not JSON', async () => {
    mockDirectory();
    mockList([proposal('p9', { payload: { nope: true } })]);
    renderAt('/skills/proposals/p9', MANAGE);
    expect(await screen.findByText(/the change it describes is incomplete or no longer valid/)).toBeInTheDocument();
  });
});
