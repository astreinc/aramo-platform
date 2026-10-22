import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { platformApi, type PersonalReviewItem } from '../platform-api';
import { platformSession } from '../skills/test-session';

import { PersonalInviteView } from './PersonalInviteView';
import { actionsFor, PersonalReviewView, signalLabel } from './PersonalReviewView';

// Aramo Sign Personal (Free) §6.5/§10 — the operator's review queue (signals and
// risk points visible; every action needs a reason; close needs a confirmation)
// and pilot invite codes (shown once, with a copy button). Both pages sit behind
// platform:tenant:lifecycle:manage.

const REVIEW: PersonalReviewItem = {
  tenant_id: 't-review',
  tenant_name: 'Pat Lee',
  owner_email: 'pat@gmail.com',
  state: 'review',
  reason: 'signup_risk',
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
  risk_points: null,
  signals: [{ key: 'abuse_reports', points: 3 }],
  restricted_until: '2026-10-24T00:00:00Z',
  report_count: 4,
};

const renderIn = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('PersonalReviewView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists accounts with state, risk points, signals, and the actions their state allows', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW, RESTRICTED] });
    renderIn(<PersonalReviewView />);
    const row = await screen.findByTestId('personal-review-t-review');
    expect(within(row).getByText('In review')).toBeInTheDocument();
    expect(within(row).getByTestId('personal-review-points')).toHaveTextContent('65');
    expect(within(row).getByTestId('personal-review-signals')).toHaveTextContent('Hosting, VPN or Tor network +25');
    expect(within(row).getByTestId('personal-review-signals')).toHaveTextContent('Form completed very quickly +40 · 2.1 s');
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Reports', 'Clear review', 'Restrict', 'Close account']);
    const r2 = screen.getByTestId('personal-review-t-restricted');
    expect(within(r2).getByText('Restricted')).toBeInTheDocument();
    expect(within(r2).getByText('Abuse reports', { selector: 'dt' })).toBeInTheDocument();
    expect(within(r2).getAllByRole('button').map((b) => b.textContent)).toEqual(['Reports', 'Reinstate', 'Close account']);
  });

  it('while SMS is unavailable, clear review says it lifts the phone step (and still does not verify the phone)', async () => {
    const held: PersonalReviewItem = {
      ...REVIEW,
      reason: 'step_up_phone_unavailable',
      step_up_required: true,
      review_clears_phone_step: true,
      geo: { country: null, looked_up_at: '2026-10-20T00:00:00Z', db_version: null },
    };
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [held], phone_verification_available: false });
    renderIn(<PersonalReviewView />);
    const row = await screen.findByTestId('personal-review-t-review');
    expect(within(row).getByText('Phone step needed; phone verification unavailable')).toBeInTheDocument();
    expect(within(row).getByTestId('personal-review-geo')).toHaveTextContent('Unknown · no location database');
    fireEvent.click(within(row).getByRole('button', { name: 'Clear review' }));
    const note = await screen.findByTestId('personal-clear-lifts-phone');
    expect(note).toHaveTextContent('Clearing review does not verify the phone.');
    expect(note).toHaveTextContent("also lifts this account's phone step");
    expect(note).toHaveTextContent('The phone stays recorded as not verified.');
    expect(screen.queryByTestId('personal-clear-keeps-phone')).toBeNull();
  });

  it('an account whose phone step was lifted by review shows that (phone still not verified)', async () => {
    const lifted: PersonalReviewItem = { ...RESTRICTED, step_up_cleared_by: 'review', geo: { country: 'GB', looked_up_at: '2026-10-20T00:00:00Z', db_version: 'GeoLite2-Country 2026-10-19T00:00:00.000Z' } };
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [lifted] });
    renderIn(<PersonalReviewView />);
    const row = await screen.findByTestId('personal-review-t-restricted');
    expect(within(row).getByTestId('personal-review-step-cleared')).toHaveTextContent('Lifted by review (phone not verified)');
    expect(within(row).getByTestId('personal-review-geo')).toHaveTextContent('GB · GeoLite2-Country 2026-10-19T00:00:00.000Z');
  });

  it('clear review needs a reason, says it does not verify the phone, and reloads', async () => {
    const list = vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValueOnce({ items: [REVIEW] }).mockResolvedValueOnce({ items: [] });
    const act = vi.spyOn(platformApi, 'personalReviewAction').mockResolvedValue({});
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear review' }));
    expect(await screen.findByText(/Clearing review does not verify the phone/)).toBeInTheDocument();
    expect(screen.getByTestId('personal-clear-keeps-phone')).toBeInTheDocument();
    const confirm = screen.getByTestId('personal-action-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Looks genuine' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(act).toHaveBeenCalledWith('t-review', 'clear-review', { reason: 'Looks genuine' }));
    expect(await screen.findByText('Clear review: Pat Lee.')).toBeInTheDocument();
    expect(await screen.findByTestId('personal-review-empty')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('restrict sends an optional end time; close needs a confirmation', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW] });
    const act = vi.spyOn(platformApi, 'personalReviewAction').mockResolvedValue({});
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restrict' }));
    fireEvent.change(await screen.findByLabelText('Reason (required)'), { target: { value: 'Reported phishing' } });
    fireEvent.change(screen.getByLabelText('Restrict until (optional)'), { target: { value: '2026-10-25T10:00' } });
    fireEvent.click(screen.getByTestId('personal-action-confirm'));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(act.mock.calls[0]?.[1]).toBe('restrict');
    expect(act.mock.calls[0]?.[2]).toEqual({ reason: 'Reported phishing', until: new Date('2026-10-25T10:00').toISOString() });

    fireEvent.click(await screen.findByRole('button', { name: 'Close account' }));
    fireEvent.change(await screen.findByLabelText('Reason (required)'), { target: { value: 'Confirmed abuse' } });
    expect(screen.getByTestId('personal-action-confirm')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('personal-action-confirm'));
    await waitFor(() => expect(act).toHaveBeenLastCalledWith('t-review', 'close', { reason: 'Confirmed abuse' }));
  });

  it('shows the backend refusal of an action and a load failure', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [RESTRICTED] });
    vi.spyOn(platformApi, 'personalReviewAction').mockRejectedValue(new ApiError(409, 'Illegal transition', 'CONFLICT', { reason: 'not_restricted' }));
    const view = renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reinstate' }));
    fireEvent.change(await screen.findByLabelText('Reason (required)'), { target: { value: 'Appeal upheld' } });
    fireEvent.click(screen.getByTestId('personal-action-confirm'));
    expect(await screen.findByText('Illegal transition (not_restricted)')).toBeInTheDocument();
    view.unmount();
    vi.spyOn(platformApi, 'listPersonalReview').mockRejectedValue(new Error('x'));
    renderIn(<PersonalReviewView />);
    expect(await screen.findByText('Could not load the review queue.')).toBeInTheDocument();
  });

  it('a review owed under a restriction can still be cleared, and says so', async () => {
    const owed = { ...RESTRICTED, review_pending: true };
    expect(actionsFor(owed)).toEqual(['clear-review', 'reinstate', 'close']);
    expect(actionsFor(RESTRICTED)).toEqual(['reinstate', 'close']);
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [owed] });
    renderIn(<PersonalReviewView />);
    const row = await screen.findByTestId('personal-review-t-restricted');
    expect(within(row).getByTestId('personal-review-owed')).toHaveTextContent('A review is still owed');
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Reports', 'Clear review', 'Reinstate', 'Close account']);
  });

  it('lists the reports behind an account and records an outcome with a reason', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [RESTRICTED] });
    const report = {
      id: 'r-1',
      envelope_id: 'e-1',
      reason: 'phishing',
      note: 'Asked for my bank login',
      reporter_domain: 'gmail.com',
      weight: 1.5,
      triggered_restriction: true,
      outcome: 'OPEN' as const,
      outcome_reason: null,
      decided_at: null,
      created_at: '2026-10-21T00:00:00Z',
    };
    const list = vi
      .spyOn(platformApi, 'listPersonalReports')
      .mockResolvedValueOnce({ items: [report] })
      .mockResolvedValueOnce({ items: [{ ...report, outcome: 'FALSE_REPORT', outcome_reason: 'Sender verified' }] });
    const decide = vi.spyOn(platformApi, 'decidePersonalReport').mockResolvedValue({ ...report, outcome: 'FALSE_REPORT' });
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByTestId('personal-review-reports'));
    const reports = await screen.findByTestId('personal-reports');
    expect(list).toHaveBeenCalledWith('t-restricted');
    expect(reports).toHaveTextContent('From gmail.com · weight 1.50');
    expect(reports).toHaveTextContent('Asked for my bank login');
    fireEvent.click(within(reports).getByRole('button', { name: 'Mark false report' }));
    const save = screen.getByTestId('personal-report-decide');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason for/), { target: { value: 'Sender verified' } });
    fireEvent.click(save);
    await waitFor(() => expect(decide).toHaveBeenCalledWith('r-1', { outcome: 'FALSE_REPORT', reason: 'Sender verified' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('False report')).toBeInTheDocument();
  });

  it('shows an empty reports list', async () => {
    vi.spyOn(platformApi, 'listPersonalReview').mockResolvedValue({ items: [REVIEW] });
    vi.spyOn(platformApi, 'listPersonalReports').mockResolvedValue({ items: [] });
    renderIn(<PersonalReviewView />);
    fireEvent.click(await screen.findByTestId('personal-review-reports'));
    expect(await screen.findByTestId('personal-reports-empty')).toHaveTextContent('No reports.');
  });

  it('signalLabel names every signal the backend records (incl. the GeoLite2 location signals)', () => {
    expect(signalLabel('ip_country_outside')).toBe('Network location outside the supported countries');
    expect(signalLabel('ip_country_unknown')).toBe('Network location unknown');
    expect(signalLabel('send_location_outside')).toBe('Sent from outside the supported countries');
    expect(signalLabel('send_location_unknown')).toBe('Sent from an unknown network location');
    expect(signalLabel('step_up_phone_unavailable')).toBe('Phone step needed; phone verification unavailable');
    for (const k of ['robot_check_low', 'robot_check_failed', 'honeypot_filled', 'network_hosting_vpn_tor', 'ip_signups_24h', 'phone_ip_country_mismatch', 'gmail_alias_of_existing', 'fast_form', 'random_looking', 'phone_reused']) {
      expect(signalLabel(k)).not.toBe(k.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase()));
    }
  });

  it('signalLabel falls back to a readable key', () => {
    expect(signalLabel('phone_reused')).toBe('Phone already used by another account');
    expect(signalLabel('new_signal_kind')).toBe('New signal kind');
  });
});

describe('PersonalInviteView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues a code for an email, shows it once, and copies it', async () => {
    const issue = vi.spyOn(platformApi, 'issuePersonalInvite').mockResolvedValue({ code: 'PILOT-7Q2K-91XZ', email: 'pat@gmail.com', expires_at: '2026-10-28T00:00:00Z' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderIn(<PersonalInviteView />);
    const submit = screen.getByTestId('personal-invite-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: ' pat@gmail.com ' } });
    fireEvent.click(submit);
    expect(await screen.findByTestId('personal-invite-code')).toHaveTextContent('PILOT-7Q2K-91XZ');
    expect(issue).toHaveBeenCalledWith({ email: 'pat@gmail.com' });
    expect(screen.getByTestId('personal-invite-issued')).toHaveTextContent('This code is shown only once.');
    // The form is cleared so the code is not re-issued by accident.
    expect(screen.getByLabelText('Email address')).toHaveValue('');
    fireEvent.click(screen.getByTestId('personal-invite-copy'));
    await waitFor(() => expect(screen.getByTestId('personal-invite-copy')).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith('PILOT-7Q2K-91XZ');
  });

  it('shows the cap refusal with its reason', async () => {
    vi.spyOn(platformApi, 'issuePersonalInvite').mockRejectedValue(new ApiError(409, 'The pilot is full', 'CONFLICT', { reason: 'pilot_cap_reached' }));
    renderIn(<PersonalInviteView />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'pat@gmail.com' } });
    fireEvent.click(screen.getByTestId('personal-invite-submit'));
    expect(await screen.findByText('The pilot is full (pilot_cap_reached)')).toBeInTheDocument();
    expect(screen.queryByTestId('personal-invite-code')).toBeNull();
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

  it('need platform:tenant:lifecycle:manage', async () => {
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
    expect(screen.getByRole('link', { name: 'Review queue' })).toHaveAttribute('href', '/personal-review');
  });
});
