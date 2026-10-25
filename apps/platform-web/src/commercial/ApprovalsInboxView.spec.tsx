import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityProvider } from '../identity/identity';
import { platformApi, type PlatformMe } from '../platform-api';

import { ApprovalsInboxView } from './ApprovalsInboxView';
import { commercialApi, type ChangeRequest, type ChangeRequestDetail } from './commercial-api';
import { ME_ID, NOW, OTHER_ID, TENANT_ID, TWO_STEP_CHAIN, detail, request, sessionFor, type FixtureRole } from './test-fixtures';

// CCP-B1 — the Approvals inbox and the change-request drawer, against a mocked
// typed client (the routes themselves are proven by CCP-A3 / CCP-A10). The two
// mandatory UI facts: an ineligible user gets no usable approve action, and when
// the backend refuses an approve the UI shows the engine's refusal (the call is
// made through the route client, never decided locally).

const ME: PlatformMe = { user_id: ME_ID, email: 'priya.shah@aramo.ai', display_name: 'Priya Shah', tenant_id: 't0', tenant_name: 'Aramo Platform', role_keys: ['finance_admin'] };

interface World {
  list: ChangeRequest[];
  eligible: string[];
  details: Record<string, ChangeRequestDetail>;
}

function mock(w: World) {
  vi.spyOn(commercialApi, 'listChangeRequests').mockImplementation(async (p = {}) => ({
    requests: p.eligibleForMe === true ? w.list.filter((r) => w.eligible.includes(r.id)) : w.list,
    next_cursor: null,
  }));
  vi.spyOn(commercialApi, 'getChangeRequest').mockImplementation(async (id) => {
    const d = w.details[id];
    if (!d) throw new ApiError(404, 'nf', 'NOT_FOUND');
    return d;
  });
  vi.spyOn(platformApi, 'listTenants').mockResolvedValue({
    tenants: [{ id: TENANT_ID, name: 'Northwind Logistics', kind: 'BUSINESS', slug: 'northwind', status: 'ACTIVE', status_reason_code: null, status_changed_at: '', is_active: true, created_at: '', activated_at: null, suspended_at: null }],
  });
}

function renderInbox(role: FixtureRole = 'finance_admin', url = '/commercial/approvals') {
  return render(
    <ToastProvider>
      <IdentityProvider session={sessionFor(role)} load={() => Promise.resolve(ME)}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/commercial/approvals" element={<ApprovalsInboxView session={sessionFor(role)} now={() => NOW} />} />
          </Routes>
        </MemoryRouter>
      </IdentityProvider>
    </ToastProvider>,
  );
}

const credit = request({ id: '0f3a91c2-0000-7000-8000-000000000001' });
const discount = request({ id: '0f3a91c2-0000-7000-8000-000000000002', action_type: 'DISCOUNT', payload: { discount_bps: 3000 }, required_chain: TWO_STEP_CHAIN, expires_at: '2026-10-26T09:00:00.000Z' });
const mine = request({ id: '0f3a91c2-0000-7000-8000-000000000003', state: 'DRAFT', submitted_at: null, expires_at: null, requested_by: ME_ID });
const done = request({ id: '0f3a91c2-0000-7000-8000-000000000004', state: 'REJECTED', rejected_at: '2026-10-23T09:00:00.000Z', rejected_by: OTHER_ID, rejection_reason: 'No evidence.' });

function world(): World {
  return {
    list: [credit, discount, mine, done],
    eligible: [credit.id],
    details: {
      [credit.id]: detail(credit),
      [discount.id]: detail(discount, { refusal: 'OUT_OF_ORDER' }),
      [mine.id]: detail(mine, { refusal: 'NOT_PENDING' }),
      [done.id]: detail(done),
    },
  };
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('Approvals inbox (handoff §5.1)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('CCP-R3 (CCP-A1 Amendment A1) a caller without platform:billing:amount:read: the server omits the CREDIT amount; the row and the drawer show the withheld state and no figure', async () => {
    const withheldCredit = { ...credit, payload: { currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' } };
    const w = world();
    mock({ ...w, list: [withheldCredit, discount, mine, done], details: { ...w.details, [credit.id]: detail(withheldCredit) } });
    renderInbox();
    const row = await screen.findByTestId(`cr-row-${credit.id}`);
    expect(within(row).getByText('Amount withheld — Finance amount access required')).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/\$|350/);
    fireEvent.click(row);
    await screen.findByTestId('cr-drawer');
    expect(screen.getByRole('dialog')).toHaveTextContent('Account credit · Amount withheld — Finance amount access required');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\$350/);
  });

  it('tabs carry counts; Waiting on me is the default and lists only the eligible request', async () => {
    mock(world());
    renderInbox();
    await screen.findByTestId(`cr-row-${credit.id}`);
    expect(tab(/^Waiting on me/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Waiting on me/)).toHaveTextContent('1');
    expect(tab(/^All pending/)).toHaveTextContent('2');
    expect(tab(/^Requested by me/)).toHaveTextContent('1');
    expect(tab(/^History/)).toHaveTextContent('1');
    const row = screen.getByTestId(`cr-row-${credit.id}`);
    expect(within(row).getByText('Account credit')).toBeInTheDocument();
    expect(within(row).getByText('Northwind Logistics')).toBeInTheDocument();
    expect(within(row).getByText('$350 account credit')).toBeInTheDocument();
    expect(within(row).getByText('67 h left')).toBeInTheDocument();
    expect(screen.queryByTestId(`cr-row-${discount.id}`)).toBeNull();
  });

  it('All pending sorts by soonest expiry; the chain shows step state', async () => {
    mock(world());
    renderInbox();
    await screen.findByTestId(`cr-row-${credit.id}`);
    fireEvent.click(tab(/^All pending/));
    const rows = screen.getAllByTestId(/^cr-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([`cr-row-${discount.id}`, `cr-row-${credit.id}`]);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByText(/Finance/)).toBeInTheDocument();
    expect(within(first).getByText(/Owner/)).toBeInTheDocument();
  });

  it('each tab has its designed empty state', async () => {
    mock({ list: [], eligible: [], details: {} });
    renderInbox();
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
    fireEvent.click(tab(/^All pending/));
    expect(screen.getByText('No pending requests')).toBeInTheDocument();
    fireEvent.click(tab(/^Requested by me/));
    expect(screen.getByText('You haven’t made any requests')).toBeInTheDocument();
    fireEvent.click(tab(/^History/));
    expect(screen.getByText('No history yet')).toBeInTheDocument();
  });

  it('shows the bootstrap banner for a chain the A3 gate reports unfulfillable', async () => {
    const w = world();
    w.details[discount.id] = detail(discount, { refusal: 'OUT_OF_ORDER', satisfiable: false });
    mock(w);
    renderInbox();
    const banner = await screen.findByTestId('bootstrap-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Commercial approvals unavailable: not enough distinct approvers for Above threshold (Finance → Owner).');
    expect(banner).toHaveTextContent('409 CCP_NOT_BOOTSTRAPPED');
  });
});

describe('the change-request drawer (handoff §5.2)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens from a row: facts, stepper, effect, chain, eligibility, timeline', async () => {
    mock(world());
    renderInbox();
    fireEvent.click(await screen.findByTestId(`cr-row-${credit.id}`));
    const dr = await screen.findByTestId('cr-drawer');
    expect(screen.getByRole('dialog')).toHaveTextContent('Account credit · $350 account credit');
    expect(within(dr).getByText('Northwind Logistics · Aramo Sign')).toBeInTheDocument();
    expect(within(dr).getByText(/Expires 2026-10-27 09:00 UTC · 67 h left/)).toBeInTheDocument();
    expect(within(dr).getByText(/chain Below threshold: Finance \(fixed at creation\) · 72 h window/)).toBeInTheDocument();
    expect(within(dr).getByRole('list', { name: 'Request state' })).toBeInTheDocument();
    expect(within(dr).getByText('Finance · Finance admin')).toBeInTheDocument();
    expect(within(dr).getByTestId('eligibility-verdict')).toHaveTextContent('You can sign the Finance step');
    expect(within(dr).getByText('Submitted for approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it.each([
    ['NOT_HUMAN', 'Not a human actor'],
    ['SELF_APPROVAL', 'You requested this'],
    ['USER_ALREADY_APPROVED', 'You already approved a step'],
    ['STEP_SCOPE_MISSING', 'Missing the scope for this step'],
    ['OUT_OF_ORDER', 'Out of order'],
  ])('an ineligible user (%s) sees the reason inline and no usable approve action', async (refusal, label) => {
    const w = world();
    w.details[credit.id] = detail(credit, { refusal });
    mock(w);
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    const dr = await screen.findByTestId('cr-drawer');
    expect(within(dr).getByTestId('eligibility-verdict')).toHaveTextContent(`You can’t approve: ${label}`);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeDisabled();
    expect(screen.getByTestId('cr-footnote')).toHaveTextContent(`${label}.`);
  });

  it('NOT_PENDING and EXPIRED: no approve action at all / disabled with the reason', async () => {
    const w = world();
    w.details[credit.id] = detail({ ...credit, expires_at: '2026-10-24T12:00:00.000Z' }, { expired: true });
    mock(w);
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    await screen.findByTestId('cr-drawer');
    expect(screen.getByTestId('eligibility-verdict')).toHaveTextContent('You can’t approve: Expired');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('the combined Finance + Owner person is refused the second step: "You already approved a step"', async () => {
    const w = world();
    w.details[discount.id] = detail(discount, { signed: 1, refusal: 'USER_ALREADY_APPROVED', approver: ME_ID });
    mock(w);
    renderInbox('platform_owner', `/commercial/approvals?request=${discount.id}`);
    const dr = await screen.findByTestId('cr-drawer');
    expect(within(dr).getByText(/^Signed by Priya Shah/)).toBeInTheDocument();
    expect(within(dr).getByTestId('eligibility-verdict')).toHaveTextContent('You can’t approve: You already approved a step');
    expect(within(dr).getByTestId('eligibility-verdict')).toHaveTextContent('One person can sign only one step, even when they hold two roles.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('approve goes through the route with the current step; the backend refusal is shown inline (409)', async () => {
    mock(world());
    const approve = vi.spyOn(commercialApi, 'approve').mockRejectedValue(new ApiError(409, 'approval refused: STEP_SCOPE_MISSING', 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'STEP_SCOPE_MISSING' }));
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    await screen.findByTestId('cr-drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dlg = await screen.findByRole('dialog', { name: /Approve the Finance step/ });
    expect(dlg).toHaveTextContent('Pending approval');
    expect(dlg).toHaveTextContent('Approved');
    expect(dlg).toHaveTextContent('You sign the Finance step as Finance admin.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByTestId('cr-refusal');
    expect(approve).toHaveBeenCalledWith(credit.id, 0);
    expect(alert).toHaveTextContent('Approval refused. Missing the scope for this step. The Finance step needs the Finance admin role.');
    expect(alert).toHaveTextContent('409 COMMERCIAL_APPROVAL_REFUSED · STEP_SCOPE_MISSING');
  });

  it('409 CCP_NOT_BOOTSTRAPPED: the drawer alert and the page banner', async () => {
    mock(world());
    vi.spyOn(commercialApi, 'approve').mockRejectedValue(new ApiError(409, 'nb', 'CCP_NOT_BOOTSTRAPPED', { unfillable_steps: [0] }));
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    await screen.findByTestId('cr-drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Approve the Finance step/ })).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByTestId('cr-refusal')).toHaveTextContent('Approval refused. The Below threshold chain doesn’t have enough distinct eligible approvers yet. (409 CCP_NOT_BOOTSTRAPPED)');
    expect(await screen.findByTestId('bootstrap-banner')).toHaveTextContent('Below threshold (Finance)');
  });

  it('approve success: the step is signed through the route and the lists reload', async () => {
    const w = world();
    mock(w);
    const approved = { ...credit, state: 'APPROVED', approved_at: '2026-10-24T14:00:00.000Z' };
    const approve = vi.spyOn(commercialApi, 'approve').mockImplementation(async () => {
      w.details[credit.id] = detail(approved, { signed: 1, approver: ME_ID });
      w.list = w.list.map((r) => (r.id === credit.id ? approved : r));
      w.eligible = [];
      const approval = (w.details[credit.id] as ChangeRequestDetail).approvals[0] as ChangeRequestDetail['approvals'][number];
      return { request: approved, approval, apply: null };
    });
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    await screen.findByTestId('cr-drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Approve the Finance step/ })).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(credit.id, 0));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
    // The drawer is still open (the page behind it is aria-hidden).
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Waiting on me/, hidden: true })).toHaveTextContent('0'));
  });

  it('reject needs a reason and calls the route; a refusal stays in the dialog', async () => {
    mock(world());
    const reject = vi.spyOn(commercialApi, 'reject').mockRejectedValueOnce(new ApiError(409, 'r', 'COMMERCIAL_APPROVAL_REFUSED', { refusal: 'NOT_PENDING' })).mockResolvedValue({ request: { ...credit, state: 'REJECTED' } });
    renderInbox('finance_admin', `/commercial/approvals?request=${credit.id}`);
    await screen.findByTestId('cr-drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    const dlg = await screen.findByRole('dialog', { name: /^Reject / });
    const commit = within(dlg).getByRole('button', { name: 'Reject request' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(/Reason \(required\)/), { target: { value: 'No evidence attached.' } });
    fireEvent.click(commit);
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Rejection refused. Not pending.');
    fireEvent.click(commit);
    await waitFor(() => expect(reject).toHaveBeenLastCalledWith(credit.id, 'No evidence attached.'));
  });

  it('the requester of a draft gets Submit for approval and Withdraw, and no approve action', async () => {
    mock(world());
    const submit = vi.spyOn(commercialApi, 'submit').mockResolvedValue({ request: { ...mine, state: 'PENDING_APPROVAL' } });
    renderInbox('commercial_ops', `/commercial/approvals?request=${mine.id}`);
    await screen.findByTestId('cr-drawer');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(mine.id));
  });
});
