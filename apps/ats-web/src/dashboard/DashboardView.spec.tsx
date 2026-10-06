import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// CRM-7 — Done/Snooze call the Task PATCH; gate on task:write.
const h = vi.hoisted(() => ({ scopes: ['task:read', 'task:write'], updateTask: vi.fn() }));
vi.mock('../task/task-api', () => ({ updateTask: h.updateTask }));
vi.mock('@aramo/fe-foundation', async (importActual) => {
  const actual = await importActual<typeof import('@aramo/fe-foundation')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'authenticated' as const,
      session: { sub: 'u1', consumer_type: 'recruiter' as const, tenant_id: 't', scopes: h.scopes, iat: 0, exp: 9_999_999_999 },
    }),
    hasScope: (s: { scopes?: string[] } | null, scope: string) => s?.scopes?.includes(scope) ?? false,
  };
});

const getMyDeskMock = vi.mocked(getMyDesk);

function makeDesk(overrides: Partial<MyDeskView> = {}): MyDeskView {
  return {
    generated_at: '2026-09-29T16:00:00.000Z',
    server_date: '2026-09-29',
    priority_items: [
      { id: 'a', kind: 'rtr', talent_id: 't1', talent_name: 'Marcus Lee', requisition_id: 'r1', requisition_label: 'REQ-1001', label: 'Marcus Lee', reason: 'Qualified 4 days ago · RTR not sent.', due_at: '2026-09-27T12:00:00Z', urgency: 'overdue', primary_action: { kind: 'open_task', label: 'Open task', href: '/talent/t1' }, task_id: null },
      { id: 'b', kind: 'submittal', talent_id: 't2', talent_name: 'Hannah Kim', requisition_id: 'r1', requisition_label: 'REQ-1001', label: 'Hannah Kim', reason: 'Ready to submit — all Submittal Policy checks met.', due_at: null, urgency: 'today', primary_action: { kind: 'submit_to_client', label: 'Submit to client', href: '/talent/t2/submittal/r1' }, task_id: null },
      { id: 'c', kind: 'task', talent_id: null, talent_name: null, requisition_id: 'r2', requisition_label: 'REQ-1004', label: 'Send prep notes', reason: '', due_at: '2026-10-01T12:00:00Z', urgency: 'upcoming', primary_action: { kind: 'open_task', label: 'Open task', href: '/requisitions/r2' }, task_id: 'c' },
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

beforeEach(() => {
  h.scopes = ['task:read', 'task:write'];
  h.updateTask.mockResolvedValue({});
});
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
    // SW-5 (§9.4) — an RTR work item's action opens the Submittal Workspace,
    // deep-linked to its RTR requirement via a presentation-only focus hint.
    const action = screen.getAllByRole('link', { name: 'Open task' })[0];
    expect(action).toHaveAttribute('href', '/talent/t1/submittal/r1/workspace?focus=rtr');
  });

  it('renders a domain-derived submittal-ready item with the Submit-to-client CTA routing into the submittal flow', async () => {
    getMyDeskMock.mockResolvedValue(makeDesk());
    renderDesk();
    const submit = await screen.findByRole('link', { name: 'Submit to client' });
    // SW-5 (§9.4) — the Submit-to-client work item opens the Submittal Workspace.
    expect(submit).toHaveAttribute('href', '/talent/t2/submittal/r1/workspace');
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

  it('§11 — an offer_expiring exception renders a Continue link deep-linking into /offer-start/:pipelineId (over the generic requisition link)', async () => {
    getMyDeskMock.mockResolvedValue(
      makeDesk({
        exceptions: [
          {
            id: 'x2', kind: 'offer_expiring', severity: 'medium',
            title: 'Offer expiring · Liam OConnor', body: 'Offer expires soon.',
            talent_id: 't9', requisition_id: 'r1', owned_by_me: true, owner_label: null,
            primary_action: { kind: 'continue_offer_start', label: 'Continue in Offer & Start', href: '/offer-start/pipe-77' },
          },
        ],
      }),
    );
    renderDesk();
    const link = await screen.findByTestId('desk-exc-continue');
    expect(link.getAttribute('href')).toBe('/offer-start/pipe-77');
    expect(link.textContent).toBe('Continue in Offer & Start');
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

  // --- CRM-7 (§11) — follow-up CTA + Task controls (Done/Snooze) ---
  // A follow-up Task with a Call CTA (no requisition + voice permitted), kept
  // OUT of the shared fixture so it doesn't perturb the count assertions above.
  const FOLLOW_UP = {
    id: 'd', kind: 'follow_up' as const, talent_id: 't6', talent_name: 'Sofia Alvarez',
    requisition_id: null, requisition_label: null, label: 'Sofia Alvarez',
    reason: 'Call back about hybrid days', due_at: '2026-09-29T12:00:00Z', urgency: 'today' as const,
    primary_action: { kind: 'call' as const, label: 'Call', href: null }, task_id: 'd',
  };
  const deskWithFollowUp = () => makeDesk({ priority_items: [FOLLOW_UP] });
  function followUpRow(): HTMLElement {
    return screen.getByText('Call back about hybrid days').closest('.rc-desk-row') as HTMLElement;
  }

  it('renders the communication-authority CTA (Call) on a follow-up row', async () => {
    getMyDeskMock.mockResolvedValue(deskWithFollowUp());
    renderDesk();
    await screen.findByText('Sofia Alvarez');
    // Call routes to the talent surface (where the authority executes it).
    const cta = within(followUpRow()).getByRole('link', { name: 'Call' });
    expect(cta).toHaveAttribute('href', '/talent/t6');
  });

  it('Done completes the Task via PATCH (status=done) and refreshes the desk', async () => {
    getMyDeskMock.mockResolvedValue(deskWithFollowUp());
    renderDesk();
    await screen.findByText('Sofia Alvarez');
    fireEvent.click(within(followUpRow()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(h.updateTask).toHaveBeenCalledWith('d', { status: 'done' }));
    expect(getMyDeskMock.mock.calls.length).toBeGreaterThanOrEqual(2); // desk refreshed
  });

  it('Snooze → Tomorrow bumps the Task due_date via PATCH', async () => {
    getMyDeskMock.mockResolvedValue(deskWithFollowUp());
    renderDesk();
    await screen.findByText('Sofia Alvarez');
    fireEvent.click(within(followUpRow()).getByRole('button', { name: 'Snooze' }));
    fireEvent.click(within(followUpRow()).getByRole('button', { name: 'Tomorrow' }));
    await waitFor(() => expect(h.updateTask).toHaveBeenCalledTimes(1));
    const [id, body] = h.updateTask.mock.calls[0]!;
    expect(id).toBe('d');
    expect(body).toHaveProperty('due_date');
    expect(typeof body.due_date).toBe('string'); // an ISO instant in the future
  });

  it('hides Done/Snooze for a read-only actor (no task:write)', async () => {
    h.scopes = ['task:read'];
    getMyDeskMock.mockResolvedValue(deskWithFollowUp());
    renderDesk();
    await screen.findByText('Sofia Alvarez');
    expect(within(followUpRow()).queryByRole('button', { name: 'Done' })).toBeNull();
    expect(within(followUpRow()).queryByRole('button', { name: 'Snooze' })).toBeNull();
  });
});
