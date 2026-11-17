import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { ENVELOPE_MESSAGE_MAX, type SenderContext } from '../api';

// UAT SND-20 — the web Review & send step takes a sender message (Sign Mobile
// M-A3 §3) limited to 1,000 characters, and saves it before the envelope is sent.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };
const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@example.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Acme', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  organization_url: null,
  app_home_url: null,
};
const ENV = {
  id: 'e1',
  subject: 'Lease',
  status: 'DRAFT',
  created_at: '2026-10-01T00:00:00Z',
  sent_at: null,
  completed_at: null,
  declined_at: null,
  voided_at: null,
  expires_at: null,
  signing_window_days: 7,
  sender: { id: 'u1', name: 'Pat Lee' },
  editable: true,
  message: null,
  documents: [{ id: 'd1', title: 'Lease', ordinal: 0, content_type: 'application/pdf', byte_size: 10, source_sha256: 'x', field_count: 1 }],
  recipients: [{ id: 's1', name: 'Sam', email: 'sam@x.test', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null }],
  fields: [{ id: 'f1', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(calls: { method: string; url: string; body: unknown }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
      if (url.endsWith('/envelopes/e1/send')) return json({ ...ENV, status: 'SENT' });
      if (url.endsWith('/envelopes/e1')) return json(ENV);
      return json({ items: [], counts: {} });
    }),
  );
}

function show() {
  render(
    <MemoryRouter initialEntries={['/sign/envelopes/e1/edit?step=4']}>
      <App />
    </MemoryRouter>,
  );
}

describe('Review & send — message to recipients (UAT SND-20)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('is enabled and limited to 1,000 characters', async () => {
    stub([]);
    show();
    const area = (await screen.findByTestId('envelope-message')) as HTMLTextAreaElement;
    expect(area).toBeEnabled();
    expect(area.maxLength).toBe(ENVELOPE_MESSAGE_MAX);
    expect(ENVELOPE_MESSAGE_MAX).toBe(1000);
    fireEvent.change(area, { target: { value: 'x'.repeat(1001) } });
    expect(area.value).toHaveLength(1000);
    expect(screen.getByTestId('envelope-message-count')).toHaveTextContent('1000 / 1000');
  });

  it('saves the message before sending', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    stub(calls);
    show();
    fireEvent.change(await screen.findByTestId('envelope-message'), { target: { value: '  Please sign by Friday.  ' } });
    fireEvent.click(screen.getByTestId('send-envelope'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/envelopes/e1/send'))).toBe(true));
    const patch = calls.findIndex((c) => c.method === 'PATCH' && c.url.endsWith('/envelopes/e1'));
    const send = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/envelopes/e1/send'));
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(patch).toBeLessThan(send);
    expect(calls[patch]?.body).toEqual({ message: 'Please sign by Friday.' });
  });

  it('does not save an unchanged empty message', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    stub(calls);
    show();
    fireEvent.click(await screen.findByTestId('send-envelope'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/envelopes/e1/send'))).toBe(true));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
