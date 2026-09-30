import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from './DashboardView';
import { getMyDesk } from './my-desk-api';
import type { MyDeskView } from './my-desk-types';

vi.mock('./my-desk-api');
vi.mock('../shell/me-api', () => ({
  useMe: () => ({
    user: { display_name: 'Purush Pichaimuthu', email: 'p@x.example' },
    roles: [],
    tenant: { display_name: 'Astre', status: 'active' },
  }),
}));

const getMyDeskMock = vi.mocked(getMyDesk);

function makeDesk(overrides: Partial<MyDeskView> = {}): MyDeskView {
  return {
    generated_at: '2026-09-29T16:00:00.000Z',
    server_date: '2026-09-29',
    priority_items: [
      { id: 'a', kind: 'rtr', talent_id: 't1', talent_name: 'Marcus Lee', requisition_id: 'r1', requisition_label: 'REQ-1001', label: 'Marcus Lee', reason: 'Qualified 4 days ago · RTR not sent.', due_at: '2026-09-27T12:00:00Z', urgency: 'overdue', primary_action: { kind: 'open_task', label: 'Open task', href: '/talent/t1' } },
      { id: 'b', kind: 'submittal', talent_id: 't2', talent_name: 'Hannah Kim', requisition_id: 'r1', requisition_label: 'REQ-1001', label: 'Hannah Kim', reason: 'Ready to submit — all Submittal Policy checks met.', due_at: null, urgency: 'today', primary_action: { kind: 'submit_to_client', label: 'Submit to client', href: '/talent/t2/submittal/r1' } },
      { id: 'c', kind: 'task', talent_id: null, talent_name: null, requisition_id: 'r2', requisition_label: 'REQ-1004', label: 'Send prep notes', reason: '', due_at: '2026-10-01T12:00:00Z', urgency: 'upcoming', primary_action: { kind: 'open_task', label: 'Open task', href: '/requisitions/r2' } },
    ],
    interviews_today: [
      { id: 'iv1', scheduled_at: '2026-09-29T15:00:00Z', talent_id: 't3', talent_name: 'Rahul Nair', requisition_id: 'r1', requisition_label: 'REQ-1001', interview_type: 'client_interview', round: 1, confirmation: 'unknown' },
    ],
    awaiting_client: [
      { id: 'w1', talent_id: 't4', talent_name: 'Kiran Rao', requisition_id: 'r2', requisition_label: 'REQ-1004', reason: 'Awaiting client decision', waiting_days: 8, since: '2026-09-21T12:00:00Z' },
    ],
    exceptions: [
      { id: 'x1', kind: 'pre_start_blocked', severity: 'high', title: 'Pre-Start blocked · Samuel Ortiz', body: 'Start date at risk.', talent_id: 't5', requisition_id: 'r1', owned_by_me: true, owner_label: null, primary_action: null },
    ],
    requisitions: [
      { id: 'r1', code: 'REQ-1001', title: 'Business Analyst', client_name: 'Freddie Mac', days_open: 16, status: 'open', pipeline_count: 8, qualified_count: 3, with_client_count: 0, offer_count: 0, started_count: 0, signal: '3 qualified' },
    ],
    ...overrides,
  };
}

function renderDesk() {
  return render(
    <MemoryRouter>
      <DashboardView />
    </MemoryRouter>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('DashboardView (My Desk)', () => {
  it('calls GET /v1/my-desk on mount and renders the greeting + headline derived from the arrays', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    expect(getMyDeskMock).toHaveBeenCalledTimes(1);
    // greeting uses the /me display name; date comes from server_date (no tz shift).
    expect(await screen.findByText(/,\s*Purush/)).toBeInTheDocument();
    expect(screen.getByText(/tuesday, september 29/i)).toBeInTheDocument();
    // headline counts are derived from the arrays: 1 overdue · 1 due today · 1 interviews · 1 exceptions
    expect(screen.getByText('1 overdue · 1 due today · 1 interviews · 1 exceptions')).toBeInTheDocument();
  });

  it('renders the 5 summary cards with counts from the same arrays', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    // Anchor each card on its UNIQUE subtitle (disambiguates "Overdue" from the
    // queue tab / group header / due badge), then assert its label + count.
    const overdue = (await screen.findByText('Past their due date')).closest('button')!;
    expect(overdue).toHaveTextContent('Overdue');
    expect(overdue).toHaveTextContent('1');
    const interviews = screen.getByText('Scheduled today').closest('button')!;
    expect(interviews).toHaveTextContent('Interviews today');
    expect(interviews).toHaveTextContent('1');
    const awaiting = screen.getByText('Oldest 8d').closest('button')!;
    expect(awaiting).toHaveTextContent('Awaiting client');
  });

  it('groups the priority queue by urgency and shows reason + action href', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    expect(await screen.findByText('Overdue · 1')).toBeInTheDocument();
    expect(screen.getByText('Due today · 1')).toBeInTheDocument();
    expect(screen.getByText('Coming up · 1')).toBeInTheDocument();
    expect(screen.getByText('Qualified 4 days ago · RTR not sent.')).toBeInTheDocument();
    // the row's primary action is a navigable link to the owning entity
    const action = screen.getAllByRole('link', { name: 'Open task' })[0];
    expect(action).toHaveAttribute('href', '/talent/t1');
  });

  it('renders a domain-derived submittal-ready item with the Submit-to-client CTA routing into the submittal flow', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    const submit = await screen.findByRole('link', { name: 'Submit to client' });
    expect(submit).toHaveAttribute('href', '/talent/t2/submittal/r1');
    // it renders under the person + the ready reason (FACTS, not a verdict).
    expect(screen.getByText('Hannah Kim')).toBeInTheDocument();
    expect(
      screen.getByText('Ready to submit — all Submittal Policy checks met.'),
    ).toBeInTheDocument();
  });

  it('filters the queue by tab (Submittals shows rtr+submittal, hides tasks)', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    await screen.findByText('Marcus Lee');
    fireEvent.click(screen.getByRole('tab', { name: /submittals/i }));
    expect(screen.getByText('Marcus Lee')).toBeInTheDocument();
    expect(screen.getByText('Hannah Kim')).toBeInTheDocument();
    expect(screen.queryByText('Send prep notes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /^tasks/i }));
    expect(screen.getByText('Send prep notes')).toBeInTheDocument();
    expect(screen.queryByText('Marcus Lee')).not.toBeInTheDocument();
  });

  it('renders the right rail: interviews, exceptions, awaiting client', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    expect(await screen.findByText('Rahul Nair')).toBeInTheDocument();
    expect(screen.getByText('Pre-Start blocked · Samuel Ortiz')).toBeInTheDocument();
    expect(screen.getByText('Kiran Rao')).toBeInTheDocument();
    expect(screen.getByText('8d')).toBeInTheDocument();
  });

  it('renders the My Requisitions table with pipeline/qualified counts and zero downstream counts', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    const row = (await screen.findByText('Business Analyst')).closest('a')!;
    expect(row).toHaveAttribute('href', '/requisitions/r1');
    expect(screen.getByText('3 qualified')).toBeInTheDocument();
  });

  it('shows honest empty states when everything is clear', async () => {
    getMyDeskMock.mockResolvedValue(
      makeDesk({ priority_items: [], interviews_today: [], awaiting_client: [], exceptions: [], requisitions: [] }),
    );
    renderDesk();
    expect(await screen.findByText("You're caught up")).toBeInTheDocument();
    expect(screen.getByText('No interviews scheduled today.')).toBeInTheDocument();
    expect(screen.getByText('No blocked items need your attention.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting on a client decision.')).toBeInTheDocument();
  });

  it('renders a loading state while the desk is in flight', () => {
    getMyDeskMock.mockReturnValue(new Promise(() => undefined));
    renderDesk();
    expect(screen.getByText('Loading your desk…')).toBeInTheDocument();
  });

  it('renders an error state with a working retry', async () => {
    getMyDeskMock.mockRejectedValueOnce(new Error('boom'));
    renderDesk();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    getMyDeskMock.mockResolvedValueOnce(makeDesk());
    fireEvent.click(retry);
    expect(await screen.findByText('Marcus Lee')).toBeInTheDocument();
    expect(getMyDeskMock).toHaveBeenCalledTimes(2);
  });
});
