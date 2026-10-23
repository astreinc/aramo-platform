import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { type Session } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from './portal-disputes-api';
import { PortalDisputesView } from './PortalDisputesView';

// Portal P3b — the tenant disposition worklist talks to one api module (mocked).
// Asserts the FE behaviour: the worklist renders, triage/correct are gated on
// identity:resolve, and the dispositions call the api.

vi.mock('./portal-disputes-api', () => ({
  getPortalDisputes: vi.fn(),
  triageDispute: vi.fn(),
  correctDispute: vi.fn(),
  upholdDispute: vi.fn(),
  requestInfoDispute: vi.fn(),
}));

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 } as Session;
}
const REVIEWER = makeSession(['identity:resolve']);

function renderView(session: Session = REVIEWER) {
  return render(
    <MemoryRouter>
      <PortalDisputesView sessionOverride={session} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no session in test')));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const OPEN_ITEM: api.PortalDisputeItem = {
  dispute_id: 'dddddddd-dddd-7ddd-8ddd-ddddddddddd1',
  talent_record_ids: ['aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'],
  assertion_id: 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee',
  item_type: 'VERIFICATION_OUTCOME',
  contributed_by: 'TALENT_INTELLIGENCE',
  status: 'OPEN',
  arrived_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
  triage_due_at: '2026-07-19T00:00:00.000Z',
  reinvestigation_due_at: '2026-08-15T00:00:00.000Z',
};
const list = (disputes: api.PortalDisputeItem[], intelligence_status: api.PortalDisputeList['intelligence_status'] = 'ENABLED'): api.PortalDisputeList => ({
  intelligence_status,
  disputes,
  next_cursor: null,
});

describe('PortalDisputesView — tenant disposition worklist', () => {
  it('renders the worklist and offers Triage on an OPEN dispute', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([OPEN_ITEM]));
    renderView();
    expect(await screen.findByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('VERIFICATION_OUTCOME')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Triage' })).toBeInTheDocument();
  });

  it('triage fires the api and refetches', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([OPEN_ITEM]));
    vi.mocked(api.triageDispute).mockResolvedValue({ dispute_id: OPEN_ITEM.dispute_id, status: 'UNDER_REVIEW' });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Triage' }));
    await waitFor(() => expect(api.triageDispute).toHaveBeenCalledWith(OPEN_ITEM.dispute_id));
    expect(api.getPortalDisputes).toHaveBeenCalledTimes(2); // mount + post-triage
  });

  it('correct requires a note then calls correctDispute', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([{ ...OPEN_ITEM, status: 'UNDER_REVIEW' }]));
    vi.mocked(api.correctDispute).mockResolvedValue({ dispute_id: OPEN_ITEM.dispute_id, status: 'RESOLVED_CORRECTED' });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    const note = screen.getByLabelText('Resolution note');
    fireEvent.change(note, { target: { value: 'the anchor is not theirs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.correctDispute).toHaveBeenCalledWith(OPEN_ITEM.dispute_id, 'the anchor is not theirs'),
    );
  });

  it('hides disposition actions without identity:resolve', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([OPEN_ITEM]));
    renderView(makeSession([]));
    await screen.findByText('Verification');
    expect(screen.queryByRole('button', { name: 'Triage' })).not.toBeInTheDocument();
  });

  it('Talent Intelligence not enabled → an honest note and no rows', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([], 'NOT_ENTITLED'));
    renderView();
    expect(await screen.findByTestId('disputes-ti-status')).toHaveTextContent('Talent Intelligence not enabled.');
    expect(screen.getByText('No open disputes.')).toBeInTheDocument();
  });

  it('uphold requires a note then calls upholdDispute', async () => {
    vi.mocked(api.getPortalDisputes).mockResolvedValue(list([{ ...OPEN_ITEM, status: 'UNDER_REVIEW' }]));
    vi.mocked(api.upholdDispute).mockResolvedValue({ dispute_id: OPEN_ITEM.dispute_id, status: 'RESOLVED_UPHELD' });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Uphold' }));
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'it stands' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.upholdDispute).toHaveBeenCalledWith(OPEN_ITEM.dispute_id, 'it stands'));
  });
});
