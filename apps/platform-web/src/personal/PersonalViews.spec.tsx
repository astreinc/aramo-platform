import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { platformApi, type PersonalAbuseReport, type PersonalReviewItem } from '../platform-api';
import { platformSession } from '../skills/test-session';

import { PersonalInviteView, expiryLine } from './PersonalInviteView';
import { PersonalReviewView, ReviewActionDialog } from './PersonalReviewView';
import {
  INVITE_PILOT_FULL,
  SIGNAL_LABEL_COUNT,
  UNTIL_IN_PAST,
  actionSpec,
  actionsFor,
  applyRiskView,
  inviteErrorText,
  reasonLabel,
  reviewErrorText,
  signalLabel,
  signalTotal,
  untilAsUtc,
  visibleItems,
} from './personal-review-model';

// PLATFORM-UX-1 F-6 (handoff §8; amendment 3, 5, 11; R-19) — the Sign Personal
// review queue (state filter + sort, table, drawer with signals and reports,
// footer actions by state, reasoned action dialogs) and pilot invites (one-time
// code, no seat count). Both pages sit behind platform:tenant:lifecycle:manage.

const REVIEW: PersonalReviewItem = {
  tenant_id: 't-review',
  tenant_name: 'Pat Lee',
  owner_email: 'pat@gmail.com',
  state: 'review',
  reason: 'signup_review',
  review_pending: true,
  risk_points: 65,
  signals: [
    { key: 'network_hosting', points: 25 },
    { key: 'fast_form', points: 40, detail: '2.1 s' },
  ],
  phone_verified_at: null,
  restricted_until: null,
  report_count: 0,
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
};
const RESTRICTED: PersonalReviewItem = {
  ...REVIEW,
  tenant_id: 't-restricted',
  tenant_name: 'Sam Roe',
  owner_email: 'sam@gmail.com',
  state: 'restricted',
  reason: 'abuse_reports',
  review_pending: false,
  risk_points: null,
  signals: [{ key: 'abuse_reports', points: 3 }],
  phone_verified_at: '2026-10-21T00:00:00Z',
  restricted_until: '2026-10-24T00:00:00Z',
  report_count: 2,
  created_at: '2026-10-22T00:00:00Z',
};
const OPEN_REPORT: PersonalAbuseReport = {
  id: 'r-open',
  envelope_id: 'e1',
  reason: 'impersonation',
  note: 'Used a bank name.',
  reporter_domain: 'example.com',
  weight: 1,
  triggered_restriction: true,
  outcome: 'OPEN',
  outcome_reason: null,
  decided_at: null,
  created_at: '2026-10-21T09:10:00Z',
};
const DECIDED_REPORT: PersonalAbuseReport = {
  ...OPEN_REPORT,
  id: 'r-done',
  reason: 'spam',
  note: null,
  outcome: 'CONFIRMED',
  outcome_reason: 'Matches the reported pattern.',
};

const renderIn = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('personal review model', () => {
  it('maps every state to its footer actions (handoff §8.1 state table)', () => {
    expect(actionsFor({ state: 'review' })).toEqual(['clear-review', 'restrict', 'close']);
    expect(actionsFor({ state: 'restricted' })).toEqual(['reinstate', 'close']);
    expect(actionsFor({ state: 'restricted', review_pending: true })).toEqual(['reinstate', 'close', 'clear-review']);
    expect(actionsFor({ state: 'clear' })).toEqual(['restrict', 'close']);
    expect(actionsFor({ state: 'closed' })).toEqual([]);
    expect(actionsFor({ state: 'closed', review_pending: true })).toEqual([]);
  });

  it('gives each action its from → to, tone and consequence', () => {
    expect(actionSpec('clear-review', { state: 'review' })).toMatchObject({ label: 'Clear review', to: 'clear', tone: 'normal' });
    expect(actionSpec('clear-review', { state: 'restricted' })).toMatchObject({
      to: 'restricted',
      consequence: 'Marks the owed review as done. The restriction stays in place.',
    });
    expect(actionSpec('restrict', { state: 'clear' })).toMatchObject({ label: 'Restrict account', to: 'restricted', tone: 'privileged' });
    expect(actionSpec('reinstate', { state: 'restricted' })).toMatchObject({ label: 'Reinstate account', to: 'clear', tone: 'privileged' });
    expect(actionSpec('close', { state: 'review' })).toMatchObject({ label: 'Close account', to: 'closed', tone: 'danger' });
  });

  it('labels signals and reasons, and totals recorded signal points (R-19)', () => {
    expect(SIGNAL_LABEL_COUNT).toBe(23);
    expect(signalLabel('ip_country_outside')).toBe('Network location outside the supported countries');
    expect(signalLabel('step_up_phone_unavailable')).toBe('Phone step needed; phone verification unavailable');
    expect(signalLabel('new_signal_kind')).toBe('New signal kind');
    expect(reasonLabel('signup_review')).toBe('Signals passed the review threshold');
    expect(reasonLabel('Appeal upheld after a call.')).toBe('Appeal upheld after a call.');
    expect(reasonLabel(null)).toBe('—');
    expect(signalTotal(REVIEW)).toBe(65);
  });

  it('filters by state and sorts by signup (newest) or restriction end (soonest, none last)', () => {
    const clear = { ...REVIEW, tenant_id: 't-clear', state: 'clear' as const, created_at: '2026-10-01T00:00:00Z' };
    const items = [REVIEW, RESTRICTED, clear];
    expect(visibleItems(items, 'ALL', 'signed').map((i) => i.tenant_id)).toEqual(['t-restricted', 't-review', 't-clear']);
    expect(visibleItems(items, 'ALL', 'until').map((i) => i.tenant_id)[0]).toBe('t-restricted');
    expect(visibleItems(items, 'review', 'signed').map((i) => i.tenant_id)).toEqual(['t-review']);
    expect(visibleItems(items, 'closed', 'signed')).toEqual([]);
  });

  it('reads the "until" value as UTC', () => {
    expect(untilAsUtc('2026-11-07T15:00')?.toISOString()).toBe('2026-11-07T15:00:00.000Z');
    expect(untilAsUtc('')).toBeNull();
  });

  it('maps the review refusals to operator copy', () => {
    const err = (reason: string) => new ApiError(400, 'refused', 'VALIDATION_ERROR', { reason });
    expect(reviewErrorText(err('until_in_past'), REVIEW, 'x')).toBe(UNTIL_IN_PAST);
    expect(reviewErrorText(err('illegal_risk_transition'), { state: 'closed' }, 'x')).toBe(
      'This change isn’t allowed from Closed (illegal_risk_transition).',
    );
    expect(reviewErrorText(new ApiError(404, 'nope', 'NOT_FOUND', { reason: 'no_personal_risk_state' }), REVIEW, 'x')).toBe(
      'This tenant isn’t a Sign Personal account, so it has no review state (no_personal_risk_state).',
    );
    expect(reviewErrorText(new Error('boom'), REVIEW, 'fallback')).toBe('fallback');
  });

  it('merges an action response into the account snapshot', () => {
    const next = applyRiskView(REVIEW, { state: 'restricted', restricted_until: '2026-11-07T00:00:00.000Z', reason: 'Spam' }, {
      to: 'restricted',
      reason: 'Spam',
      clearedReview: false,
    });
    expect(next).toMatchObject({ state: 'restricted', restricted_until: '2026-11-07T00:00:00.000Z', reason: 'Spam', review_pending: true });
    expect(applyRiskView(REVIEW, undefined, { to: 'clear', reason: 'ok', clearedReview: true })).toMatchObject({
      state: 'clear',
      review_pending: false,
    });
  });
});

describe('PersonalReviewView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the state filter with counts, the table columns and the rows', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW, RESTRICTED] });
    renderIn(<PersonalReviewView />);
    const row = await screen.findByTestId('personal-review-t-review');
    expect(screen.getByRole('heading', { name: 'Sign Personal review queue' })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'State' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All2',
      'In review1',
      'Restricted1',
      'Clear0',
      'Closed0',
    ]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Account',
      'State',
      'Reason',
      'Risk points',
      'Phone',
      'Reports',
      'Signed up',
      'Restricted until',
    ]);
    expect(row).toHaveTextContent('Pat Lee');
    expect(row).toHaveTextContent('pat@gmail.com');
    expect(row).toHaveTextContent('In review');
    expect(row).toHaveTextContent('Review owed');
    expect(row).toHaveTextContent('Signals passed the review threshold');
    expect(within(row).getByTestId('personal-review-points')).toHaveTextContent('65');
    expect(row).toHaveTextContent('Not verified');
    expect(row).toHaveTextContent('20 Oct 2026');
    const r2 = screen.getByTestId('personal-review-t-restricted');
    expect(r2).toHaveTextContent('Verified');
    expect(r2).toHaveTextContent('24 Oct 2026');
    expect(within(r2).getByTestId('personal-review-points')).toHaveTextContent('—');
    // Newest signup first by default.
    expect(screen.getAllByTestId(/^personal-review-t-/).map((r) => r.dataset['testid'])).toEqual([
      'personal-review-t-restricted',
      'personal-review-t-review',
    ]);
  });

  it('filters by state and shows the designed empty state', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW, RESTRICTED] });
    renderIn(<PersonalReviewView />);
    await screen.findByTestId('personal-review-t-review');
    fireEvent.click(screen.getByRole('button', { name: /^Restricted/ }));
    expect(screen.getByRole('button', { name: /^Restricted/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('personal-review-t-review')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Closed/ }));
    expect(screen.getByTestId('personal-review-empty')).toHaveTextContent('Nothing in this state');
    expect(screen.getByTestId('personal-review-empty')).toHaveTextContent('No Sign Personal accounts match this filter.');
  });

  it('shows a load failure', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockRejectedValue(new ApiError(500, 'Server error', 'INTERNAL_ERROR'));
    renderIn(<PersonalReviewView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server error');
  });

  it('opens the drawer with facts, labelled signals and the recorded-signals header', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW] });
    vi.spyOn(platformApi, 'listPersonalReports').mockResolvedValue({ items: [] });
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pat Lee' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByTestId('personal-signal-total')).toHaveTextContent('65 risk points from recorded signals');
    const signals = within(drawer).getByTestId('personal-review-signals');
    expect(signals).toHaveTextContent('Hosting, VPN or Tor network+25network_hosting');
    expect(signals).toHaveTextContent('Form completed very quickly+40fast_form · 2.1 s');
    expect(drawer).toHaveTextContent('pat@gmail.com · t-review');
    expect(drawer).toHaveTextContent('Not verified · No phone step');
    expect(drawer).toHaveTextContent('Review owedYes');
    expect(await within(drawer).findByTestId('personal-reports-empty')).toHaveTextContent('No abuse reports.');
    expect(within(drawer).getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Clear review', 'Restrict…', 'Close account…']),
    );
    expect(within(drawer).queryByRole('button', { name: 'Reinstate…' })).toBeNull();
  });

  it('shows reports with outcome pills and decide actions only on open reports', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [RESTRICTED] });
    vi.spyOn(platformApi, 'listPersonalReports').mockResolvedValue({ items: [OPEN_REPORT, DECIDED_REPORT] });
    const decide = vi.spyOn(platformApi, 'decidePersonalReport').mockResolvedValue({ ...OPEN_REPORT, outcome: 'FALSE_REPORT' });
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sam Roe' }));
    const open = await screen.findByTestId('personal-report-r-open');
    expect(open).toHaveTextContent('Impersonation');
    expect(open).toHaveTextContent('Open');
    expect(open).toHaveTextContent('“Used a bank name.”');
    expect(within(open).getAllByRole('button').map((b) => b.textContent)).toEqual(['Confirm…', 'Mark false report…', 'Dismiss…']);
    const done = screen.getByTestId('personal-report-r-done');
    expect(done).toHaveTextContent('Spam');
    expect(done).toHaveTextContent('Confirmed');
    expect(done).toHaveTextContent('Decision: Matches the reported pattern.');
    expect(within(done).queryAllByRole('button')).toEqual([]);

    fireEvent.click(within(open).getByRole('button', { name: 'Mark false report…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as false report' });
    const commit = within(dialog).getByRole('button', { name: 'Mark as false report' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: ' Recipient asked for it ' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(decide).toHaveBeenCalledWith('r-open', { outcome: 'FALSE_REPORT', reason: 'Recipient asked for it' }));
  });

  it('keeps a closed account and its reports viewable after closing it, with no further actions', async () => {
    vi.spyOn(platformApi, 'listPersonalReview')
      .mockResolvedValueOnce({ items: [RESTRICTED] })
      .mockResolvedValue({ items: [] });
    vi.spyOn(platformApi, 'listPersonalReports').mockResolvedValue({ items: [DECIDED_REPORT] });
    const act = vi.spyOn(platformApi, 'personalReviewAction').mockResolvedValue({ tenant_id: 't-restricted', state: 'closed', restricted_until: null });
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sam Roe' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close account…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close account — Sam Roe' });
    const commit = within(dialog).getByRole('button', { name: 'Close account' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Repeated confirmed reports' } });
    expect(commit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I understand this closes the account.' }));
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(act).toHaveBeenCalledWith('t-restricted', 'close', { reason: 'Repeated confirmed reports' }));
    expect(await screen.findByTestId('personal-closed-note')).toHaveTextContent(
      'This account is closed. Reports stay viewable; no further actions.',
    );
    const drawer = screen.getByTestId('personal-drawer');
    expect(within(drawer).getByTestId('personal-report-r-done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close account…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reinstate…' })).toBeNull();
  });
});

describe('ReviewActionDialog', () => {
  afterEach(() => vi.restoreAllMocks());
  const NOW = () => new Date('2026-10-24T12:00:00Z');

  function open(action: 'restrict' | 'clear-review', item: PersonalReviewItem = REVIEW) {
    const onDone = vi.fn();
    renderIn(<ReviewActionDialog item={item} action={action} onClose={() => undefined} onDone={onDone} now={NOW} />);
    return onDone;
  }

  it('needs a reason (≤ 500) and shows from → to', async () => {
    open('restrict');
    const dialog = await screen.findByRole('dialog', { name: 'Restrict account — Pat Lee' });
    expect(dialog).toHaveTextContent('In review');
    expect(dialog).toHaveTextContent('Restricted');
    expect(dialog).toHaveTextContent('The account can’t send new envelopes.');
    const commit = within(dialog).getByRole('button', { name: 'Restrict account' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'x'.repeat(600) } });
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('x'.repeat(500));
    expect(dialog).toHaveTextContent('500 / 500');
    expect(commit).toBeEnabled();
  });

  it('refuses an "until" in the past client-side and sends a future one as UTC', async () => {
    const act = vi.spyOn(platformApi, 'personalReviewAction').mockResolvedValue({ state: 'restricted' });
    const onDone = open('restrict');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Spam' } });
    fireEvent.change(within(dialog).getByLabelText('Restrict until (optional)'), { target: { value: '2026-10-01T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restrict account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNTIL_IN_PAST);
    expect(act).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Restrict until (optional)'), { target: { value: '2026-11-07T15:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restrict account' }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith('t-review', 'restrict', { reason: 'Spam', until: '2026-11-07T15:00:00.000Z' }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('maps a server refusal', async () => {
    vi.spyOn(platformApi, 'personalReviewAction').mockRejectedValue(
      new ApiError(400, 'closed', 'VALIDATION_ERROR', { reason: 'illegal_risk_transition' }),
    );
    open('restrict');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Spam' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restrict account' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This change isn’t allowed from In review (illegal_risk_transition).');
  });

  it('clear review says it lifts the phone step while phone verification is unavailable', async () => {
    open('clear-review', { ...REVIEW, review_clears_phone_step: true });
    const dialog = await screen.findByRole('dialog', { name: 'Clear review — Pat Lee' });
    expect(within(dialog).getByTestId('personal-clear-lifts-phone')).toHaveTextContent('doesn’t verify the phone');
  });
});

describe('PersonalInviteView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires an email, then shows the one-time code with its recipient and expiry', async () => {
    const issue = vi
      .spyOn(platformApi, 'issuePersonalInvite')
      .mockResolvedValue({ code: 'PILOT-7Q2K-91XZ', email: 'pat@gmail.com', expires_at: '2026-10-28T15:00:00Z' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderIn(<PersonalInviteView />);
    expect(screen.queryByText(/pilot seats/)).toBeNull();
    fireEvent.click(screen.getByTestId('personal-invite-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an email address.');
    expect(issue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' pat@gmail.com ' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByTestId('personal-invite-submit'));
    expect(await screen.findByTestId('one-time-secret')).toHaveTextContent('PILOT-7Q2K-91XZ');
    expect(issue).toHaveBeenCalledWith({ email: 'pat@gmail.com' });
    const card = screen.getByTestId('personal-invite-issued');
    expect(card).toHaveTextContent('This code is shown only once');
    expect(card).toHaveTextContent('For pat@gmail.com');
    expect(card).toHaveTextContent('Expires 28 Oct 2026, 15:00 UTC');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    fireEvent.click(within(card).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PILOT-7Q2K-91XZ'));
    fireEvent.click(within(card).getByRole('button', { name: "I've saved it — dismiss" }));
    expect(screen.queryByTestId('one-time-secret')).toBeNull();
  });

  it('maps personal_pilot_full to the pilot-full copy', async () => {
    vi.spyOn(platformApi, 'issuePersonalInvite').mockRejectedValue(
      new ApiError(400, 'The personal pilot is full', 'VALIDATION_ERROR', { reason: 'personal_pilot_full', cap: 50 }),
    );
    renderIn(<PersonalInviteView />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@gmail.com' } });
    fireEvent.click(screen.getByTestId('personal-invite-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(INVITE_PILOT_FULL);
    expect(screen.queryByTestId('one-time-secret')).toBeNull();
  });

  it('maps the other invite refusals', () => {
    expect(inviteErrorText(new ApiError(400, 'x', 'VALIDATION_ERROR', { reason: 'personal_email_required' }))).toContain(
      'personal_email_required',
    );
    expect(inviteErrorText(new ApiError(400, 'email must be an email', 'VALIDATION_ERROR'))).toBe('Enter a valid email address.');
    expect(expiryLine(null)).toBeNull();
    expect(expiryLine('2026-10-31T15:00:00Z', new Date('2026-10-24T15:00:00Z'))).toBe('31 Oct 2026, 15:00 UTC · in 7 days');
  });
});

describe('Personal operator routes', () => {
  beforeEach(() => configureAuthConsumer('platform'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function withSession(scopes: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/auth/platform/session')
          ? new Response(JSON.stringify(platformSession(scopes)), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
    );
  }

  it('need platform:tenant:lifecycle:manage (no view-only state, amendment 3)', async () => {
    withSession(['platform:tenant:read']);
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [] });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/personal-review']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/platform:tenant:lifecycle:manage/)).toBeInTheDocument();
    expect(screen.queryByTestId('personal-review')).toBeNull();
    unmount();
    withSession(['platform:tenant:read', 'platform:tenant:lifecycle:manage']);
    render(
      <MemoryRouter initialEntries={['/personal-invites']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('personal-invites')).toBeInTheDocument();
  });
});
