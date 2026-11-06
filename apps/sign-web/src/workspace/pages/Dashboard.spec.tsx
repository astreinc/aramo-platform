import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { SenderContext } from '../api';

// M-A13 #13 — each dashboard summary card opens the matching envelope list.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };

const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  personal_sending_enabled: false,
  organization_url: null,
  app_home_url: null,
};

const SUMMARY = {
  counts: { draft: 4, sent: 5, in_progress: 1, completed: 1, declined: 1, voided: 0, expired: 0 },
  awaiting_signatures: 6,
  completed_this_month: 1,
  declined_or_expired: 1,
  months: [],
  completion_rate: null,
  expiring_soon: [],
  signing_window_days: 7,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Dashboard summary cards', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  function mount() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
      if (url.endsWith('/v1/sign/sender/summary')) return json(SUMMARY);
      return json({ items: [], counts: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/personal']}>
        <App />
      </MemoryRouter>,
    );
    return fetchMock;
  }

  it('links each card to its envelope list', async () => {
    mount();
    const link = (name: RegExp) => screen.findByRole('link', { name }, { timeout: 5000 });
    expect(await link(/^Awaiting signatures: 6/)).toHaveAttribute('href', '/personal/envelopes?tab=waiting');
    expect(await link(/^Requires your action: 4/)).toHaveAttribute('href', '/personal/envelopes?tab=drafts');
    expect(await link(/^Completed this month: 1/)).toHaveAttribute('href', '/personal/envelopes?tab=completed');
    expect(await link(/^Declined or expired: 1/)).toHaveAttribute('href', '/personal/envelopes?tab=follow_up');
  });

  it('opens the declined-or-expired list from its card', async () => {
    const fetchMock = mount();
    fireEvent.click(await screen.findByRole('link', { name: /^Declined or expired: 1/ }, { timeout: 5000 }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('tab=follow_up'))).toBe(true));
  });
});
