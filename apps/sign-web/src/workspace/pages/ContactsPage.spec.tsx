import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { sendToFrom } from './EnvelopeWizard';
import { ContactsPage } from './WorkspacePages';

// UAT SND-24 (web ≡ app) — Contacts: saved contacts can be edited and deleted; recent
// recipients are marked Recent; "Send to" starts an envelope with that person as a signer.

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
const ITEMS = [
  { id: 'c1', source: 'saved', name: 'Raju', email: 'raju@x.test', organization: null, envelope_count: 3, last_used_at: '2026-11-11T10:00:00Z' },
  { id: null, source: 'recent', name: 'Ashwin', email: 'ashwin@x.test', envelope_count: 1, last_used_at: '2026-11-10T10:00:00Z' },
];

type Call = { method: string; url: string; body: unknown };
function stub(calls: Call[], patch?: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/v1/sign/sender/contacts') && method === 'GET') return json({ items: ITEMS });
      if (url.endsWith('/v1/sign/sender/contacts/c1') && method === 'PATCH') return patch ? patch() : json({ ...ITEMS[0], ...(body as object) });
      if (url.endsWith('/v1/sign/sender/contacts/c1') && method === 'DELETE') return new Response(null, { status: 204 });
      return json({});
    }),
  );
}

function show() {
  render(
    <MemoryRouter>
      <WorkspaceProvider ctx={CTX}>
        <ContactsPage />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Contacts (UAT SND-24)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('marks saved and recent; only saved contacts have Edit and Delete; Send to carries the person', async () => {
    stub([]);
    show();
    await screen.findByTestId('contact-row-raju@x.test');
    expect(screen.getByTestId('contact-row-raju@x.test')).toHaveTextContent('Saved');
    expect(screen.getByTestId('contact-row-ashwin@x.test')).toHaveTextContent('Recent');
    expect(screen.getByTestId('contact-edit-raju@x.test')).toBeInTheDocument();
    expect(screen.queryByTestId('contact-edit-ashwin@x.test')).toBeNull();
    expect(screen.queryByTestId('contact-delete-ashwin@x.test')).toBeNull();
    expect(screen.getByTestId('contact-send-ashwin@x.test')).toHaveAttribute('href', '/sign/envelopes/new?to=ashwin%40x.test&name=Ashwin');
  });

  it('edits a saved contact (PATCH) and shows the app’s refusal words', async () => {
    const calls: Call[] = [];
    stub(calls, () => json({ error: { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'contact_exists' } } }, 409));
    show();
    fireEvent.click(await screen.findByTestId('contact-edit-raju@x.test'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Raju K' } });
    fireEvent.click(screen.getByTestId('contact-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Raju K', email: 'raju@x.test', organization: null });
    expect(await screen.findByText('You already have a contact with this email.')).toBeInTheDocument();
  });

  it('deletes a saved contact after confirming', async () => {
    const calls: Call[] = [];
    stub(calls);
    show();
    fireEvent.click(await screen.findByTestId('contact-delete-raju@x.test'));
    fireEvent.click(await screen.findByTestId('contact-delete-confirm'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/contacts/c1'))).toBe(true));
  });

  it('Send to reads only a valid email', () => {
    expect(sendToFrom('?to=ashwin%40x.test&name=Ashwin')).toEqual({ name: 'Ashwin', email: 'ashwin@x.test' });
    expect(sendToFrom('?to=ashwin%40x.test')).toEqual({ name: 'ashwin@x.test', email: 'ashwin@x.test' });
    expect(sendToFrom('?to=not-an-email')).toBeNull();
    expect(sendToFrom('')).toBeNull();
  });
});
