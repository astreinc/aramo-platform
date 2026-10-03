import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import { findSubmittalForTalentJob } from '../submittals/submittals-api';

import { SubmittalWorkspaceView } from './SubmittalWorkspaceView';
import { getSubmittalWorkspace } from './submittal-workspace-api';
import type { SubmittalWorkspaceView as WorkspaceView } from './submittal-workspace-types';

// vi.mock is hoisted above the imports by vitest's transform.
vi.mock('../submittals/submittals-api', () => ({ findSubmittalForTalentJob: vi.fn() }));
vi.mock('./submittal-workspace-api', () => ({ getSubmittalWorkspace: vi.fn() }));

const findMock = vi.mocked(findSubmittalForTalentJob);
const viewMock = vi.mocked(getSubmittalWorkspace);

// A fully-ready, authorized view. Each test narrows from here.
function makeView(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    identity: {
      submittal_id: 'sub1',
      talent: { id: 't1', name: 'Divya Vasudevan' },
      requisition: { id: 'r1', title: 'Scrum Master' },
      company: { id: 'c1', name: 'Freddie Mac' },
    },
    context: {
      recruiter: { id: 'u1', name: 'Deepika Rao' },
      owner: { id: 'u2', name: 'Purush P.' },
      talent_location: 'McLean, VA',
      talent_title: 'Scrum Master',
      work_authorization: 'Permanent resident',
    },
    pipeline: { linked_episode_id: 'p1', current_stage: 'qualifying', is_live: true },
    submittal: { state: 'ready_for_review', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: 're1' },
    readiness: {
      status: 'READY',
      requirements: [
        { key: 'rtr', label: 'Right to Represent executed', required: true, satisfied: true, severity: 'blocking', source: 'documents', reason: null, remediation: null, deny_code: null },
        { key: 'resume_selected', label: 'Résumé selected for this requisition', required: true, satisfied: true, severity: 'blocking', source: 'documents', reason: null, remediation: null, deny_code: null },
      ],
    },
    documents: { rtr_satisfied: true, rtr_deny: null, resume_selected: true },
    engagement: { governed: false, policy_present: false, satisfied: true, override_available: false, unavailable: false },
    commercial: { live_bill_rate_amount: '92.00', live_bill_rate_currency: 'USD', live_bill_rate_period: 'HOURLY', submitted_bill_rate: null, submitted_rate_currency: null, submitted_rate_period: null },
    delivery: { delivery_channel: null, external_reference: null, external_submitted_at: null, submitted_at: null, submitted_by_actor_id: null },
    client_selection: { present: false, process_id: null, version: null, opened_at: null, state: null, latest_interview: null, feedback: [], available_actions: NO_CS_ACTIONS },
    actions: { can_submit_to_client: true, submit_authority: true, can_revoke: true },
    ...overrides,
  };
}

const NO_CS_ACTIONS = { can_move_to_interview: false, can_mark_selected: false, can_decline: false, can_withdraw: false, can_schedule_interview: false };

function renderWorkspace() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/talent/t1/submittal/r1/workspace']}>
        <Routes>
          <Route path="talent/:talentId/submittal/:requisitionId/workspace" element={<SubmittalWorkspaceView />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('SubmittalWorkspaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMock.mockResolvedValue({ submittal: { id: 'sub1', state: 'ready_for_review' } } as never);
  });

  it('READY + authorized → shows the Record submittal CTA and the complete banner (readiness drives the banner)', async () => {
    viewMock.mockResolvedValue(makeView());
    renderWorkspace();
    expect(await screen.findByText('Divya Vasudevan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record submittal' })).toBeInTheDocument();
    expect(screen.getByText('All requirements complete')).toBeInTheDocument();
    // lifecycle pill is distinct from the readiness banner
    expect(screen.getByText('Ready for review')).toBeInTheDocument();
  });

  it('READY but NO submit authority → no CTA, renders a view-only note (§3/§D)', async () => {
    viewMock.mockResolvedValue(makeView({ actions: { can_submit_to_client: false, submit_authority: false, can_revoke: true } }));
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.queryByRole('button', { name: 'Record submittal' })).not.toBeInTheDocument();
    expect(screen.getByText(/View only/)).toBeInTheDocument();
  });

  it('BLOCKED → renders the backend requirement reason + remediation and no Record CTA', async () => {
    viewMock.mockResolvedValue(makeView({
      readiness: {
        status: 'BLOCKED',
        requirements: [
          { key: 'rtr', label: 'Right to Represent executed', required: true, satisfied: false, severity: 'blocking', source: 'documents', reason: 'A Right to Represent is required but not executed', remediation: 'Obtain an executed Right to Represent for this requisition', deny_code: 'SUBMITTAL_RTR_NOT_EXECUTED' },
        ],
      },
      actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true },
    }));
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByText('Not ready to submit')).toBeInTheDocument();
    expect(screen.getByText('A Right to Represent is required but not executed')).toBeInTheDocument();
    expect(screen.getByText('Obtain an executed Right to Represent for this requisition')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record submittal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review blocker' })).toBeInTheDocument();
  });

  it('renders requirements generically from the payload labels (no key-based business branch)', async () => {
    viewMock.mockResolvedValue(makeView());
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByText('Right to Represent executed')).toBeInTheDocument();
    expect(screen.getByText('Résumé selected for this requisition')).toBeInTheDocument();
  });

  it('commercial: present with scope → shows live bill rate; absent (null) → no commercial card', async () => {
    viewMock.mockResolvedValue(makeView());
    const { unmount } = renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByText('$92.00 / hour')).toBeInTheDocument();
    unmount();

    vi.clearAllMocks();
    findMock.mockResolvedValue({ submittal: { id: 'sub1', state: 'ready_for_review' } } as never);
    viewMock.mockResolvedValue(makeView({ commercial: null }));
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.queryByText('Commercial')).not.toBeInTheDocument();
  });

  it('submitted_to_client → provenance record, frozen submitted rate separate from current, read-only prep', async () => {
    findMock.mockResolvedValue({ submittal: { id: 'sub1', state: 'submitted_to_client' } } as never);
    viewMock.mockResolvedValue(makeView({
      submittal: { state: 'submitted_to_client', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: 're1' },
      commercial: { live_bill_rate_amount: '95.00', live_bill_rate_currency: 'USD', live_bill_rate_period: 'HOURLY', submitted_bill_rate: '92.00', submitted_rate_currency: 'USD', submitted_rate_period: 'HOURLY' },
      delivery: { delivery_channel: 'manual_vms', external_reference: 'FG-938273', external_submitted_at: null, submitted_at: '2026-10-02T14:42:00.000Z', submitted_by_actor_id: 'u1' },
      client_selection: { present: true, process_id: 'csp1', version: 0, opened_at: '2026-10-02T14:42:00.000Z', state: 'CLIENT_REVIEW', latest_interview: null, feedback: [], available_actions: NO_CS_ACTIONS },
      actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true },
    }));
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    expect(screen.getByText('Submittal record')).toBeInTheDocument();
    expect(screen.getByText('FG-938273')).toBeInTheDocument();
    expect(screen.getByText('Submitted client rate')).toBeInTheDocument();
    expect(screen.getByText('Current requisition rate')).toBeInTheDocument(); // frozen ≠ current
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('Client response')).toBeInTheDocument();
  });

  it('client response renders state + feedback from the ClientSelection composition (no new taxonomy)', async () => {
    findMock.mockResolvedValue({ submittal: { id: 'sub1', state: 'submitted_to_client' } } as never);
    viewMock.mockResolvedValue(makeView({
      submittal: { state: 'submitted_to_client', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: 're1' },
      client_selection: {
        present: true, process_id: 'csp1', version: 1, opened_at: '2026-10-02T00:00:00.000Z', state: 'INTERVIEW',
        latest_interview: { id: 'iv1', round: 1, state: 'SCHEDULED', scheduled_at: '2026-10-07T15:00:00.000Z' },
        feedback: [{ at: '2026-10-04T00:00:00.000Z', to_state: 'INTERVIEW', reason_code: null, note: 'Would like to schedule a first interview.' }],
        available_actions: NO_CS_ACTIONS,
      },
      actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true },
    }));
    renderWorkspace();
    await screen.findByText('Divya Vasudevan');
    // The client state "Interview" surfaces (pill + interview summary + history).
    expect(screen.getAllByText('Interview').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Open interview →')).toBeInTheDocument();
    // The note appears in the latest-feedback block and the history list — both
    // composed from the same authoritative ClientSelection events.
    expect(screen.getAllByText('Would like to schedule a first interview.').length).toBeGreaterThanOrEqual(1);
  });

  it('404 → conceals (no raw status, neutral message), never reveals a hidden submittal', async () => {
    const { ApiError } = await import('@aramo/fe-foundation');
    findMock.mockResolvedValue({ submittal: { id: 'sub1', state: 'ready_for_review' } } as never);
    viewMock.mockRejectedValue(new ApiError(404, 'not found', 'NOT_FOUND'));
    renderWorkspace();
    expect(await screen.findByText('This submittal isn’t available.')).toBeInTheDocument();
  });
});
