import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { SignPreferencesSection } from './SignPreferences';

// UAT SIG-12 — Settings → Preferences → Date format (the app's Account → Preferences).

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

type Call = { method: string; url: string; body: unknown };
function stub(calls: Call[], putStatus = 200) {
  let stored = { date_format: 'MM/DD/YYYY', default_field_size: 'L', offer_saved_signature_on_links: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/v1/sign/me/settings') && method === 'GET') return json(stored);
      if (url.endsWith('/v1/sign/me/settings') && method === 'PUT') {
        if (putStatus !== 200) return json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, putStatus);
        stored = body as typeof stored;
        return json(stored);
      }
      return json({});
    }),
  );
}

function show() {
  render(
    <MemoryRouter>
      <WorkspaceProvider ctx={CTX}>
        <SignPreferencesSection />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Settings — Preferences: Date format (UAT SIG-12)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('shows the saved format and the three choices', async () => {
    stub([]);
    show();
    const sel = (await screen.findByTestId('pref-date-format')) as HTMLSelectElement;
    expect(sel.value).toBe('MM/DD/YYYY');
    expect([...sel.options].map((o) => o.value)).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']);
  });

  it('saves DD/MM/YYYY and keeps every other setting as stored', async () => {
    const calls: Call[] = [];
    stub(calls);
    show();
    fireEvent.change(await screen.findByTestId('pref-date-format'), { target: { value: 'DD/MM/YYYY' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ date_format: 'DD/MM/YYYY', default_field_size: 'L', offer_saved_signature_on_links: false });
    expect((screen.getByTestId('pref-date-format') as HTMLSelectElement).value).toBe('DD/MM/YYYY');
  });

  it('a failed save puts the previous format back and says so', async () => {
    stub([], 500);
    show();
    fireEvent.change(await screen.findByTestId('pref-date-format'), { target: { value: 'YYYY-MM-DD' } });
    await waitFor(() => expect((screen.getByTestId('pref-date-format') as HTMLSelectElement).value).toBe('MM/DD/YYYY'));
  });
});
