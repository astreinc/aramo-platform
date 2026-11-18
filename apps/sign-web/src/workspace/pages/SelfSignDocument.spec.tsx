import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { SenderContext } from '../api';
import { selfSignReturn } from '../../guest/App';
import { SELF_SIGN_NOTE } from './EnvelopeWizard';

// Web Self-Signing Amendment A2 (LOCKED) — "Sign a document" on the web.

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
const ID = '01900000-0000-7000-8000-0000000e5e1f';
const SELF_ENV = {
  id: ID,
  mode: 'self',
  subject: 'Untitled envelope',
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
  recipients: [{ id: 's1', name: 'Pat Lee', email: 'pat@example.com', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, assigned_to_me: true }],
  fields: [{ id: 'f1', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { method: string; url: string; body: unknown };

function stub(calls: Call[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
      if (url.endsWith('/v1/sign/sender/envelopes') && method === 'POST') return json({ id: ID, status: 'DRAFT', subject: 'Untitled envelope', mode: 'self' }, 201);
      if (url.endsWith(`/envelopes/${ID}/send`)) return json({ ...SELF_ENV, status: 'SENT' });
      if (url.endsWith(`/envelopes/${ID}/self-sign-session`)) return json({ session_origin: 'SELF', signer_id: 's1', token: 'tok-123', expires_at: '2026-11-18T12:00:00Z' }, 201);
      if (url.endsWith(`/envelopes/${ID}`)) return json(SELF_ENV);
      return json({ items: [], counts: {} });
    }),
  );
}

function show(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('Sign a document (A2)', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });

  it('the side menu offers Sign a document, which creates a SELF draft', async () => {
    const calls: Call[] = [];
    stub(calls);
    show('/sign/envelopes/sign-document');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/sign/sender/envelopes'))).toBe(true));
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/sign/sender/envelopes'))!;
    expect(create.body).toEqual({ mode: 'self' });
    expect(await screen.findByTestId('sign-a-document')).toBeInTheDocument();
  });

  it('a SELF envelope has no Recipients step: Document → Place fields → Sign', async () => {
    stub([]);
    show(`/sign/envelopes/${ID}/edit?step=4`);
    const nav = await screen.findByRole('navigation', { name: 'Create envelope steps' });
    expect(nav).toHaveTextContent('Document');
    expect(nav).toHaveTextContent('Place fields');
    expect(nav).toHaveTextContent('Sign');
    expect(nav).not.toHaveTextContent('Recipients');
    expect(screen.getByTestId('self-sign-note')).toHaveTextContent(SELF_SIGN_NOTE);
    expect(screen.queryByTestId('envelope-message')).toBeNull();
  });

  it('Sign now sends, asks for the SELF session and opens the signing page with the return hint', async () => {
    const calls: Call[] = [];
    stub(calls);
    show(`/sign/envelopes/${ID}/edit?step=4`);
    fireEvent.click(await screen.findByTestId('self-sign-now'));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const send = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(`/envelopes/${ID}/send`));
    const session = calls.findIndex((c) => c.method === 'POST' && c.url.endsWith(`/envelopes/${ID}/self-sign-session`));
    expect(send).toBeGreaterThanOrEqual(0);
    expect(session).toBeGreaterThan(send);
    expect(assign).toHaveBeenCalledWith(`/s/tok-123?ret=${encodeURIComponent(`/sign/envelopes/${ID}`)}`);
    expect(document.body.textContent).not.toContain('tok-123');
  });
});

describe('the signing page return hint (A2 §3.4)', () => {
  it('accepts only a same-origin workspace envelope path', () => {
    expect(selfSignReturn(`?ret=${encodeURIComponent(`/sign/envelopes/${ID}`)}`)).toBe(`/sign/envelopes/${ID}`);
    expect(selfSignReturn(`?ret=${encodeURIComponent(`/personal/envelopes/${ID}`)}`)).toBe(`/personal/envelopes/${ID}`);
    expect(selfSignReturn('')).toBeNull();
    expect(selfSignReturn(`?ret=${encodeURIComponent('https://evil.example/sign/envelopes/x')}`)).toBeNull();
    expect(selfSignReturn(`?ret=${encodeURIComponent(`//evil.example/sign/envelopes/${ID}`)}`)).toBeNull();
    expect(selfSignReturn(`?ret=${encodeURIComponent('/sign/settings/billing')}`)).toBeNull();
    expect(selfSignReturn(`?ret=${encodeURIComponent(`/sign/envelopes/${ID}/../../x`)}`)).toBeNull();
  });
});
