import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommercialProposalSection } from './CommercialProposalSection';
import {
  decideCommercialProposal,
  listCommercialProposals,
  proposeCommercialRevision,
  transitionCommercialProposal,
} from './placement-api';
import type { AssignmentCommercialView, CommercialProposalView } from './types';

// Slice #4 — CHARACTERIZATION of the Commercial-Approval section. ./placement-api is mocked
// at the network seam. Covers: the propose dialog + its live margin preview; the scope × SoD
// gating of the approve affordances (hidden without approve scope; hidden when the actor IS
// the proposer); and that the transition/decision calls fire with the correct body.

vi.mock('./placement-api', () => ({
  listCommercialProposals: vi.fn(),
  proposeCommercialRevision: vi.fn(),
  transitionCommercialProposal: vi.fn(),
  decideCommercialProposal: vi.fn(),
}));

const listProposals = vi.mocked(listCommercialProposals);
const propose = vi.mocked(proposeCommercialRevision);
const transition = vi.mocked(transitionCommercialProposal);
const decide = vi.mocked(decideCommercialProposal);

function makeSession(scopes: string[], sub = 'actor-1'): Session {
  return { sub, consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const WRITE = ['assignment:commercials:read', 'assignment:commercials:write'];
const APPROVE = ['assignment:commercials:read', 'assignment:commercials:approve'];
const READ = ['assignment:commercials:read'];

function currentTerms(overrides: Partial<AssignmentCommercialView> = {}): AssignmentCommercialView {
  return {
    contract_assignment_id: 'ca1',
    assignment_rate_version_id: 'rv1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    pay_rate_amount: '80.00',
    bill_rate_amount: '120.00',
    currency: 'USD',
    rate_period: 'HOURLY',
    spread_amount: '40.00',
    margin_percent: '33.33',
    markup_percent: '50.00',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    change_reason: null,
    recorded_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProposal(overrides: Partial<CommercialProposalView> = {}): CommercialProposalView {
  return {
    id: 'prop-1',
    contract_assignment_id: 'ca1',
    placement_process_id: 'p1',
    requisition_id: 'r1',
    talent_record_id: 'tr1',
    state: 'PENDING_REVIEW',
    proposed_pay_rate_amount: '90.00',
    proposed_bill_rate_amount: '150.00',
    proposed_currency: 'USD',
    proposed_rate_period: 'HOURLY',
    proposed_effective_from: null,
    reason: 'market adjustment',
    requested_by: 'proposer-1',
    margin: {
      current: {
        pay_rate_amount: '80.00',
        bill_rate_amount: '120.00',
        currency: 'USD',
        rate_period: 'HOURLY',
        spread_amount: '40.00',
        margin_percent: '33.33',
        markup_percent: '50.00',
      },
      proposed: {
        pay_rate_amount: '90.00',
        bill_rate_amount: '150.00',
        currency: 'USD',
        rate_period: 'HOURLY',
        spread_amount: '60.00',
        margin_percent: '40.00',
        markup_percent: '66.67',
      },
      pay_rate_delta: '+10.00',
      bill_rate_delta: '+30.00',
      margin_point_delta: '6.67',
    },
    review_decided_by: null,
    review_decided_at: null,
    review_note: null,
    client_approved_at: null,
    client_approval_recorded_by: null,
    client_reference: null,
    client_approval_source: null,
    client_approval_note: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    applied_rate_version_id: null,
    applied_by: null,
    applied_at: null,
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderSection(session: Session, current: AssignmentCommercialView | null = currentTerms()) {
  return render(
    <ToastProvider>
      <CommercialProposalSection placementId="p1" session={session} currentCommercials={current} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  listProposals.mockReset().mockResolvedValue({ items: [] });
  propose.mockReset().mockResolvedValue({ proposal: makeProposal() });
  transition.mockReset().mockResolvedValue({ proposal: makeProposal() });
  decide.mockReset().mockResolvedValue({ proposal: makeProposal() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CommercialProposalSection — propose affordance + margin preview', () => {
  it('propose action is gated by assignment:commercials:write', async () => {
    renderSection(makeSession(READ));
    expect(await screen.findByTestId('commercial-proposals-section')).toBeTruthy();
    expect(screen.queryByTestId('commercial-proposal-create-action')).toBeNull();
  });

  it('opens the propose dialog and shows a live current → proposed → delta margin preview', async () => {
    renderSection(makeSession(WRITE));
    fireEvent.click(await screen.findByTestId('commercial-proposal-create-action'));
    fireEvent.change(await screen.findByTestId('commercial-proposal-pay-input'), { target: { value: '90.00' } });
    fireEvent.change(screen.getByTestId('commercial-proposal-bill-input'), { target: { value: '150.00' } });

    const preview = await screen.findByTestId('commercial-proposal-preview');
    expect(within(preview).getByTestId('commercial-proposal-preview-current-margin').textContent).toBe('33.33%');
    expect(within(preview).getByTestId('commercial-proposal-preview-proposed-margin').textContent).toBe('40.00%');
    expect(within(preview).getByTestId('commercial-proposal-preview-pay-delta').textContent).toBe('+10.00 USD/hr');
    expect(within(preview).getByTestId('commercial-proposal-preview-bill-delta').textContent).toBe('+30.00 USD/hr');
    expect(within(preview).getByTestId('commercial-proposal-preview-margin-delta').textContent).toBe('+6.67');
  });

  it('a valid propose posts the body to the proposals endpoint', async () => {
    renderSection(makeSession(WRITE));
    fireEvent.click(await screen.findByTestId('commercial-proposal-create-action'));
    fireEvent.change(await screen.findByTestId('commercial-proposal-pay-input'), { target: { value: '90.00' } });
    fireEvent.change(screen.getByTestId('commercial-proposal-bill-input'), { target: { value: '150.00' } });
    fireEvent.change(screen.getByTestId('commercial-proposal-reason-input'), { target: { value: 'market adjustment' } });
    fireEvent.click(screen.getByTestId('commercial-proposal-create-confirm'));
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    expect(propose).toHaveBeenCalledWith('p1', {
      pay_rate_amount: '90.00',
      bill_rate_amount: '150.00',
      currency: 'USD',
      rate_period: 'HOURLY',
      reason: 'market adjustment',
    });
  });
});

describe('CommercialProposalSection — scope × SoD gating of the approve affordances', () => {
  it('HIDES the approve affordance without assignment:commercials:approve', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'PENDING_REVIEW' })] });
    renderSection(makeSession(READ, 'someone-else'));
    await screen.findByTestId('commercial-proposal-row');
    expect(screen.queryByTestId('commercial-proposal-margin-approve-action')).toBeNull();
  });

  it('HIDES the approve affordance when the actor IS the proposer (segregation of duties)', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'PENDING_REVIEW', requested_by: 'actor-1' })] });
    renderSection(makeSession(APPROVE, 'actor-1'));
    await screen.findByTestId('commercial-proposal-row');
    expect(screen.queryByTestId('commercial-proposal-margin-approve-action')).toBeNull();
  });

  it('SHOWS the approve affordance for an approver who is NOT the proposer', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'PENDING_REVIEW', requested_by: 'proposer-1' })] });
    renderSection(makeSession(APPROVE, 'reviewer-2'));
    expect(await screen.findByTestId('commercial-proposal-margin-approve-action')).toBeTruthy();
  });
});

describe('CommercialProposalSection — governed transition / decision calls', () => {
  it('DRAFT proposer submit fires the transition with action=submit', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'DRAFT', requested_by: 'actor-1' })] });
    renderSection(makeSession(WRITE, 'actor-1'));
    fireEvent.click(await screen.findByTestId('commercial-proposal-submit-action'));
    await waitFor(() => expect(transition).toHaveBeenCalledWith('p1', 'prop-1', 'submit'));
  });

  it('PENDING_REVIEW margin approve fires the decision with action=margin_approve', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'PENDING_REVIEW', requested_by: 'proposer-1' })] });
    renderSection(makeSession(APPROVE, 'reviewer-2'));
    fireEvent.click(await screen.findByTestId('commercial-proposal-margin-approve-action'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p1', 'prop-1', { action: 'margin_approve' }));
  });

  it('APPROVED apply fires the decision with action=apply', async () => {
    listProposals.mockResolvedValue({ items: [makeProposal({ state: 'APPROVED', requested_by: 'proposer-1' })] });
    renderSection(makeSession(APPROVE, 'reviewer-2'));
    fireEvent.click(await screen.findByTestId('commercial-proposal-apply-action'));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p1', 'prop-1', { action: 'apply' }));
  });

  it('PENDING_CLIENT_APPROVAL record-client-approval captures reference + source and fires client_approve', async () => {
    listProposals.mockResolvedValue({
      items: [makeProposal({ state: 'PENDING_CLIENT_APPROVAL', requested_by: 'proposer-1' })],
    });
    renderSection(makeSession(APPROVE, 'reviewer-2'));
    fireEvent.click(await screen.findByTestId('commercial-proposal-client-approve-action'));
    fireEvent.change(await screen.findByTestId('commercial-proposal-client-reference-input'), {
      target: { value: 'PO-123' },
    });
    fireEvent.click(screen.getByTestId('commercial-proposal-decision-confirm'));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith('p1', 'prop-1', {
        action: 'client_approve',
        client_approval_source: 'MANUAL',
        client_reference: 'PO-123',
      }),
    );
  });
});
