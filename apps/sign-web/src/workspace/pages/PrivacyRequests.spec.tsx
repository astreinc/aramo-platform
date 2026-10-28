import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { SenderContext } from '../api';

// Aramo-Sign-Mobile-Amendment-M-A8 §2.1 — Settings: only the Personal account owner (the
// tenant_owner of a PERSONAL tenant, `personal_account_owner` from the backend) gets
// "Delete my account". A Business user — including a non-owner member of a Personal
// tenant — sees "Your organization manages this account…" and Privacy requests, never a
// self-service delete.

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
  personal_account_owner: true,
};
const BUSINESS: SenderContext = { ...PERSONAL, tenant: { id: 't1', name: 'Northwind', kind: 'BUSINESS' }, workspace: 'sign', personal_account_owner: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(ctx: SenderContext) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(ctx);
      if (url.endsWith('/v1/sign/account/status')) return json({ closable: false, closed: false, closed_at: null });
      if (url.endsWith('/v1/sign/legal/status')) return json({ pending: [] });
      if (url.endsWith('/v1/sign/me/privacy-requests')) return json({ items: [] });
      if (url.endsWith('/v1/sign/sender/summary')) return json({ counts: {}, awaiting_signatures: 0, months: [], expiring_soon: [] });
      return json({ items: [], counts: {} });
    }),
  );
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe('Settings — account lifecycle by account type (M-A8 §2.1)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('Business: organization-managed copy and Privacy requests; no Delete my account', async () => {
    stub(BUSINESS);
    renderAt('/sign/settings/personal');
    const card = await screen.findByTestId('settings-privacy-requests');
    expect(within(card).getByTestId('privacy-business-managed')).toHaveTextContent('Your organization manages this account.');
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
    expect(screen.queryByTestId('privacy-personal-copy')).toBeNull();
  });

  it('a non-owner member of a Personal tenant is a Business user: no Delete my account', async () => {
    stub({ ...PERSONAL, personal_account_owner: false });
    renderAt('/personal/settings/personal');
    const card = await screen.findByTestId('settings-privacy-requests');
    expect(within(card).getByTestId('privacy-business-managed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('the Personal account owner keeps Delete my account', async () => {
    stub(PERSONAL);
    renderAt('/personal/settings/personal');
    const card = await screen.findByTestId('settings-privacy-requests');
    expect(within(card).getByTestId('privacy-personal-copy')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Delete my account' })).toBeInTheDocument();
    expect(within(card).queryByTestId('privacy-business-managed')).toBeNull();
  });
});
