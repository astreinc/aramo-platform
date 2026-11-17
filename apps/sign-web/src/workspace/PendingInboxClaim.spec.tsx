import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOX_CLAIM_HANDOFF_KEY } from '../inbox-claim-handoff';

import type { SenderContext } from './api';
import { PendingInboxClaim } from './PendingInboxClaim';
import { WorkspaceProvider } from './workspace';

// M-A16 §4 — the workspace takes the handed-off token once, claims it and opens the inbox.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@example.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Acme', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  organization_url: null,
  app_home_url: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function show() {
  render(
    <MemoryRouter initialEntries={['/sign']}>
      <WorkspaceProvider ctx={CTX}>
        <PendingInboxClaim />
        <Routes>
          <Route path="/sign" element={<p>home</p>} />
          <Route path="/sign/inbox" element={<p>inbox page</p>} />
        </Routes>
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('PendingInboxClaim (M-A16)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.removeItem(INBOX_CLAIM_HANDOFF_KEY);
  });

  it('claims the handed-off token once, removes it and opens Waiting for me', async () => {
    window.sessionStorage.setItem(INBOX_CLAIM_HANDOFF_KEY, 'tok-9');
    const fetchMock = vi.fn(async () => json({ id: 'b1' }));
    vi.stubGlobal('fetch', fetchMock);
    show();
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(INBOX_CLAIM_HANDOFF_KEY)).toBeNull();
    const claim = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/sign/inbox/claim')) as unknown as [string, RequestInit] | undefined;
    expect(JSON.parse(String(claim?.[1].body))).toEqual({ token: 'tok-9' });
  });

  it('does nothing without a handed-off token', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    show();
    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/sign/inbox/claim'))).toBe(false);
  });
});
