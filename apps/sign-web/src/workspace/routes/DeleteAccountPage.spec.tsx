import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { PrivacyRequestView } from '../api';
import { PrivacyRequestsSection } from '../pages/PrivacyRequests';

import { privacyTokenFromHash } from './DeleteAccountPage';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — https://sign.aramo.ai/delete-account: public
// (no sign-in), names the app and its developer, proves email ownership with a token
// from the URL FRAGMENT (dropped from the address bar, sent only in a POST body), shows
// the request ID + status + what is kept; status lookup by ID + email. And the
// signed-in Settings equivalent for Personal and Business accounts.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const TOKEN = 't'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST: PrivacyRequestView = {
  reference: 'PR-7K3M-9QX2-H4TD',
  request_type: 'DELETION',
  subject_kind: 'ACCOUNT_HOLDER',
  channel: 'WEB',
  status: 'DATA_INVENTORY',
  status_label: 'Being reviewed by the Aramo privacy team',
  referred_to_organization: false,
  due_at: '2026-11-27T00:00:00.000Z',
  created_at: '2026-10-28T00:00:00.000Z',
  updated_at: '2026-10-28T00:00:00.000Z',
  completed_at: null,
  outcome_code: null,
  outcome_text: null,
  retained: [{ key: 'signing_evidence', label: 'Signed agreements', why: 'Kept under the retention rules.' }],
  organization_decides: null,
  privacy_contact: 'privacy@aramo.ai',
};

function open(fetch: ReturnType<typeof vi.fn>, hash = '') {
  window.history.replaceState(null, '', `/delete-account${hash}`);
  vi.stubGlobal('fetch', fetch);
  return render(
    <MemoryRouter initialEntries={['/delete-account']}>
      <App />
    </MemoryRouter>,
  );
}

describe('/delete-account (public)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('works without sign-in, names the app and developer, and emails a confirmation link (same answer for any email)', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/privacy-requests/start') ? json({ received: true }, 202) : json({}, 401)));
    open(fetch);
    const form = await screen.findByTestId('delete-account-form');
    // M-A8 §2.2 — the page is "Privacy and account requests" (the URL stays).
    expect(form).toHaveTextContent('Privacy and account requests');
    expect(form).not.toHaveTextContent('Delete your Aramo Sign account');
    expect(screen.getByTestId('delete-account-identity')).toHaveTextContent('Astre Consulting Services Inc');
    expect(screen.getByTestId('delete-account-explainer')).toHaveTextContent('your organization decides');
    fireEvent.change(screen.getByTestId('privacy-email'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByTestId('privacy-submit'));
    expect(await screen.findByTestId('delete-account-sent')).toHaveTextContent('Check your email');
    const call = fetch.mock.calls.find((c) => String(c[0]).endsWith('/start'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ email: 'pat@example.com', request_type: 'DELETION' });
  });

  it('reads the token from the fragment, drops it from the address bar, verifies it in the body and shows the request', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/privacy-requests/verify') ? json(REQUEST) : json({}, 401)));
    open(fetch, `#token=${TOKEN}`);
    const done = await screen.findByTestId('delete-account-request');
    expect(window.location.hash).toBe('');
    expect(within(done).getByTestId('privacy-reference')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
    expect(within(done).getByTestId('privacy-status')).toHaveTextContent('Being reviewed');
    expect(within(done).getByTestId('privacy-retained')).toHaveTextContent('Signed agreements');
    const call = fetch.mock.calls.find((c) => String(c[0]).endsWith('/verify'));
    expect(String(call?.[0])).not.toContain(TOKEN);
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ token: TOKEN });
  });

  it('an unusable link says so', async () => {
    open(vi.fn(async () => json({ error: {} }, 404)), `#token=${TOKEN}`);
    expect(await screen.findByTestId('delete-account-invalid')).toHaveTextContent('can’t be used');
  });

  it('looks up a request by ID + email', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/privacy-requests/status') ? json(REQUEST) : json({}, 401)));
    open(fetch);
    await screen.findByTestId('privacy-status-form');
    fireEvent.change(screen.getByLabelText('Request ID'), { target: { value: 'PR-7K3M-9QX2-H4TD' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByTestId('privacy-status-submit'));
    expect(await screen.findByTestId('delete-account-request')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
  });

  it('privacyTokenFromHash ignores short or missing tokens', () => {
    expect(privacyTokenFromHash('#token=abc')).toBeNull();
    expect(privacyTokenFromHash('')).toBeNull();
    expect(privacyTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
  });
});

describe('Settings → Delete account / privacy requests', () => {
  const wrap = (node: ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

  it('Personal: a clear deletion request confirmed with DELETE; shows the request ID and status', async () => {
    const requester = vi.fn(async () => REQUEST);
    wrap(<PrivacyRequestsSection personal loader={async () => ({ items: [] })} requester={requester} onDeleted={vi.fn()} />);
    const card = await screen.findByTestId('settings-privacy-requests');
    expect(within(card).getByTestId('privacy-personal-copy')).toHaveTextContent('keeps only what we must');
    const button = screen.getByRole('button', { name: 'Delete my account' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(button);
    await waitFor(() => expect(requester).toHaveBeenCalledWith('DELETION'));
    expect(await screen.findByTestId('settings-privacy-result')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
  });

  it('Business (M-A8 §2): organization-managed — no self-service delete; Privacy requests for every right', async () => {
    const requester = vi.fn(async (t: string) => ({ ...REQUEST, request_type: t as PrivacyRequestView['request_type'], subject_kind: 'BUSINESS_MEMBER' }));
    wrap(<PrivacyRequestsSection personal={false} loader={async () => ({ items: [] })} requester={requester} />);
    const card = await screen.findByTestId('settings-privacy-requests');
    expect(within(card).getByTestId('privacy-business-managed')).toHaveTextContent(
      'Your organization manages this account. Contact your organization administrator to manage product access.',
    );
    expect(card).toHaveTextContent('Privacy requests');
    expect(card).toHaveTextContent('Aramo stays responsible');
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request deletion' })).toBeNull();
    expect(card).not.toHaveTextContent('Delete account');
    for (const t of ['ACCESS', 'EXPORT', 'CORRECTION', 'DELETION']) expect(within(card).getByTestId(`settings-privacy-type-${t}`)).toBeInTheDocument();

    // ACCESS goes straight through.
    fireEvent.click(within(card).getByTestId('settings-privacy-send'));
    await waitFor(() => expect(requester).toHaveBeenCalledWith('ACCESS'));
    expect(await screen.findByTestId('settings-privacy-result')).toHaveTextContent('PR-7K3M-9QX2-H4TD');

    // DELETION of eligible personal information needs DELETE.
    fireEvent.click(within(card).getByTestId('settings-privacy-type-DELETION'));
    expect(within(card).getByTestId('settings-privacy-send')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(within(card).getByTestId('settings-privacy-send'));
    await waitFor(() => expect(requester).toHaveBeenLastCalledWith('DELETION'));
  });

  it('an open deletion request is shown instead of a new one', async () => {
    wrap(<PrivacyRequestsSection personal loader={async () => ({ items: [REQUEST] })} requester={vi.fn()} />);
    expect(await screen.findByTestId('settings-privacy-result')).toHaveTextContent('PR-7K3M-9QX2-H4TD');
    expect(screen.queryByLabelText('Type DELETE to confirm')).toBeNull();
  });
});

