import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { AccountStatus, SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { AccountClosedPage, CloseAccountSection } from './AccountClose';

// Aramo Sign Personal (Free) — Settings → Close account: shown only to the owner of
// an open Personal account (backend-decided), confirmed by typing CLOSE, then the
// user is signed out to "Your account is closed"; a closed account opens on that notice.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read'], iat: 0, exp: 9_999_999_999 };

const PERSONAL: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  personal_sending_enabled: true,
  organization_url: null,
  app_home_url: null,
};
const BUSINESS: SenderContext = { ...PERSONAL, tenant: { id: 't1', name: 'Northwind', kind: 'BUSINESS' }, workspace: 'sign' };

const OPEN: AccountStatus = { closable: true, closed: false, closed_at: null };
const CLOSED: AccountStatus = { closable: false, closed: true, closed_at: '2026-10-22T10:00:00.000Z' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(ctx: SenderContext, account: AccountStatus) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/sign/session')) return json(SESSION);
    if (url.endsWith('/v1/sign/sender/context')) return json(ctx);
    if (url.endsWith('/v1/sign/account/status')) return json(account);
    if (url.endsWith('/v1/sign/legal/status')) return json({ pending: [] });
    if (url.endsWith('/v1/sign/sender/summary')) return json({ counts: {}, awaiting_signatures: 0, months: [], expiring_soon: [] });
    return json({ items: [], counts: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

function section(props: Parameters<typeof CloseAccountSection>[0]) {
  vi.stubGlobal('fetch', vi.fn(async () => json({ awaiting_signatures: 0 })));
  return render(
    <MemoryRouter>
      <WorkspaceProvider ctx={PERSONAL}>
        <CloseAccountSection {...props} />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Close account (Personal)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('the Personal owner sees Close account in Settings with the consequences and the download links', async () => {
    stub(PERSONAL, OPEN);
    renderAt('/personal/settings/personal');
    const card = await screen.findByTestId('settings-close-account');
    expect(card).toHaveTextContent('stops sending immediately');
    expect(card).toHaveTextContent('within 30 days');
    expect(within(card).getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', '/legal/privacy');
    expect(within(card).getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/personal/documents');
    expect(screen.getByRole('button', { name: 'Close my account' })).toBeDisabled();
  });

  it('is not shown when the backend says the account is not closable, nor to a Business account', async () => {
    stub(PERSONAL, { closable: false, closed: false, closed_at: null });
    const first = renderAt('/personal/settings/personal');
    await screen.findByTestId('settings-account');
    await waitFor(() => expect(screen.queryByTestId('settings-close-account')).toBeNull());
    first.unmount();
    const fetchMock = stub(BUSINESS, OPEN);
    renderAt('/sign/settings/personal');
    await screen.findByTestId('settings-account');
    expect(screen.queryByTestId('settings-close-account')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/v1/sign/account/status'))).toBe(false);
  });

  it('typing CLOSE enables the button; closing sends the reason and then signs out', async () => {
    const closer = vi.fn(async () => ({ state: 'closed' }));
    const onClosed = vi.fn();
    section({ loader: async () => OPEN, closer, onClosed });
    const button = await screen.findByRole('button', { name: 'Close my account' });
    fireEvent.change(screen.getByLabelText('Type CLOSE to confirm'), { target: { value: 'close' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why are you leaving? (optional)'), { target: { value: 'Done with it' } });
    fireEvent.change(screen.getByLabelText('Type CLOSE to confirm'), { target: { value: 'CLOSE' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(closer).toHaveBeenCalledWith('Done with it');
  });

  it('a refused close shows the reason and does not sign out', async () => {
    const onClosed = vi.fn();
    const closer = vi.fn(async () => {
      throw new ApiError(403, 'Only the account owner can close this account', 'INSUFFICIENT_PERMISSIONS', { reason: 'not_account_owner' });
    });
    section({ loader: async () => OPEN, closer, onClosed });
    fireEvent.change(await screen.findByLabelText('Type CLOSE to confirm'), { target: { value: 'CLOSE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close my account' }));
    expect(await screen.findByText(/account owner/)).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('the default close POSTs confirm CLOSE to /v1/sign/account/close', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/account/close') ? json({ state: 'closed', closed_at: CLOSED.closed_at }) : json({ awaiting_signatures: 0 })));
    const onClosed = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceProvider ctx={PERSONAL}>
          <CloseAccountSection loader={async () => OPEN} onClosed={onClosed} />
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    vi.stubGlobal('fetch', fetchMock);
    fireEvent.change(await screen.findByLabelText('Type CLOSE to confirm'), { target: { value: 'CLOSE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close my account' }));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/sign/account/close'))!;
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ confirm: 'CLOSE' });
  });

  it('a closed Personal account opens on "Your account is closed"', async () => {
    stub(PERSONAL, CLOSED);
    renderAt('/personal');
    expect(await screen.findByTestId('state-account-closed')).toHaveTextContent('Your account is closed');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('/account-closed is a public page (no session needed)', async () => {
    const fetchMock = vi.fn(async () => json({}, 401));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/account-closed');
    expect(await screen.findByTestId('state-account-closed')).toHaveTextContent('can no longer send documents');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    render(<AccountClosedPage />);
  });
});
