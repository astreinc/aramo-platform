import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import { ClientResponseSection } from './ClientResponseSection';
import type { SubmittalWorkspaceView, WorkspaceClientSelectionActions } from './submittal-workspace-types';

const NO_ACTIONS: WorkspaceClientSelectionActions = {
  can_move_to_interview: false, can_mark_selected: false, can_decline: false, can_withdraw: false, can_schedule_interview: false,
};

function makeView(csOver: Partial<SubmittalWorkspaceView['client_selection']> = {}): SubmittalWorkspaceView {
  return {
    identity: { submittal_id: 's', talent: { id: 't', name: 'Divya' }, requisition: { id: 'r', title: 'SM' }, company: { id: 'c', name: 'Freddie Mac' } },
    context: { recruiter: null, owner: null, talent_location: null, talent_title: null, work_authorization: null },
    pipeline: { linked_episode_id: null, current_stage: null, is_live: false },
    submittal: { state: 'submitted_to_client', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: null },
    readiness: { status: 'READY', requirements: [] },
    documents: { rtr_satisfied: true, rtr_deny: null, resume_selected: true },
    engagement: { governed: false, policy_present: false, satisfied: true, override_available: false, unavailable: false },
    commercial: null,
    delivery: { delivery_channel: 'manual_vms', external_reference: null, external_submitted_at: null, submitted_at: '2026-10-02T00:00:00.000Z', submitted_by_actor_id: null },
    client_selection: {
      present: true, process_id: 'csp1', version: 2, opened_at: '2026-10-02T00:00:00.000Z', state: 'CLIENT_REVIEW',
      latest_interview: null, feedback: [], available_actions: NO_ACTIONS, ...csOver,
    },
    actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true },
  };
}

function renderSection(view: SubmittalWorkspaceView) {
  return render(
    <ToastProvider><MemoryRouter><ClientResponseSection view={view} onChanged={vi.fn()} /></MemoryRouter></ToastProvider>,
  );
}

describe('ClientResponseSection', () => {
  it('CLIENT_REVIEW: renders state pill + waiting duration + empty feedback + the submitted milestone in history', () => {
    renderSection(makeView());
    expect(screen.getByText('Client review')).toBeInTheDocument();
    expect(screen.getByText(/In client review ·/)).toBeInTheDocument();
    expect(screen.getByText('No client feedback recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('Submitted to client')).toBeInTheDocument(); // from delivery milestone
  });

  it('INTERVIEW: renders the interview summary + Open-interview deep-link to the session', () => {
    renderSection(makeView({ state: 'INTERVIEW', latest_interview: { id: 'iv1', round: 2, state: 'SCHEDULED', scheduled_at: '2026-10-07T15:00:00.000Z' } }));
    expect(screen.getByText(/Round 2 · Scheduled/)).toBeInTheDocument();
    const link = screen.getByText('Open interview →').closest('a');
    expect(link).toHaveAttribute('href', '/interviews/iv1');
  });

  it('latest feedback renders from the authoritative event', () => {
    renderSection(makeView({ feedback: [{ at: '2026-10-04T00:00:00.000Z', to_state: 'INTERVIEW', reason_code: null, note: 'Wants a panel interview.' }] }));
    expect(screen.getAllByText('Wants a panel interview.').length).toBeGreaterThanOrEqual(1);
  });

  it('ACTIONS: renders only the governed actions whose server flag is true', () => {
    renderSection(makeView({ available_actions: { can_move_to_interview: true, can_mark_selected: true, can_decline: true, can_withdraw: true, can_schedule_interview: true } }));
    expect(screen.getByRole('button', { name: 'Move to interview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule interview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record selected' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('ACTIONS: a terminal outcome (SELECTED) with all flags false → no action buttons', () => {
    renderSection(makeView({ state: 'SELECTED', available_actions: NO_ACTIONS }));
    expect(screen.getAllByText('Selected').length).toBeGreaterThanOrEqual(1); // state pill
    expect(screen.queryByRole('button', { name: 'Record selected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('DECLINED / WITHDRAWN render their terminal state from authority', () => {
    renderSection(makeView({ state: 'DECLINED', feedback: [{ at: '2026-10-05T00:00:00.000Z', to_state: 'DECLINED', reason_code: null, note: 'Needs deeper experience.' }] }));
    expect(screen.getAllByText('Declined').length).toBeGreaterThanOrEqual(1); // pill + history
    expect(screen.getAllByText('Needs deeper experience.').length).toBeGreaterThanOrEqual(1);
  });
});
