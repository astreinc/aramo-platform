import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedMarks, SenderContext } from '../api';
import { WorkspaceProvider } from '../workspace';

import { SavedSignatureSection } from './SavedSignature';

// UAT SIG-05 — Settings → default signature and initials: view, add (type), remove
// (the app's Account → Default signature / Default initials, on the web).

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));
vi.mock('../../signature-image', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  typedSignaturePng: async () => 'data:image/png;base64,AAAA',
}));

const CTX: SenderContext = {
  user: { id: 'u1', email: 'pat@example.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Acme', kind: 'BUSINESS' },
  workspace: 'sign',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  organization_url: null,
  app_home_url: null,
};
const SIG = { kind: 'DRAWN' as const, typed_name: null, font_key: null, image_data_url: 'data:image/png;base64,SIG', updated_at: '2026-11-10T10:00:00Z' };
const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; url: string; body: unknown };
function stub(marks: SavedMarks, calls: Call[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/v1/sign/me/signature') && method === 'GET') return json(marks);
      if (url.endsWith('/v1/sign/me/settings') && method === 'GET') return json({ date_format: 'DD/MM/YYYY', default_field_size: 'L', offer_saved_signature_on_links: true });
      if (url.endsWith('/v1/sign/me/settings') && method === 'PUT') return json(JSON.parse(String(init?.body)));
      if (url.includes('/v1/sign/me/') && method === 'PUT') {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ ...b, typed_name: b['typed_name'] ?? null, font_key: b['font_key'] ?? null, updated_at: '2026-11-17T10:00:00Z' });
      }
      if (url.includes('/v1/sign/me/') && method === 'DELETE') return new Response(null, { status: 204 });
      return json({});
    }),
  );
}

function show() {
  render(
    <MemoryRouter>
      <WorkspaceProvider ctx={CTX}>
        <SavedSignatureSection />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('Settings — default signature and initials (UAT SIG-05)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('shows the saved signature and "None saved" for initials', async () => {
    stub({ signature: SIG, initials: null }, []);
    show();
    expect(await screen.findByAltText('Your default signature')).toHaveAttribute('src', SIG.image_data_url);
    expect(screen.getByTestId('saved-signature')).toHaveTextContent('Drawn');
    expect(screen.getByTestId('saved-initials')).toHaveTextContent('None saved');
    expect(screen.getByTestId('edit-signature')).toHaveTextContent('Replace');
    expect(screen.getByTestId('edit-initials')).toHaveTextContent('Add');
  });

  it('adds typed initials: the full name is stored, the initials derived (as the app does)', async () => {
    const calls: Call[] = [];
    stub({ signature: null, initials: null }, calls);
    show();
    fireEvent.click(await screen.findByTestId('edit-initials'));
    expect(screen.getByTestId('mark-typed')).toHaveValue('Pat Lee');
    expect(screen.getByLabelText('initials preview')).toHaveTextContent('PL');
    fireEvent.click(screen.getByTestId('save-mark'));
    await waitFor(() => expect(screen.getByAltText('Your default initials')).toBeInTheDocument());
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toMatch(/\/v1\/sign\/me\/initials$/);
    expect(put?.body).toEqual({ kind: 'TYPED', typed_name: 'Pat Lee', font_key: 'system-script', image_data_url: 'data:image/png;base64,AAAA' });
  });

  it('removes the signature after confirming', async () => {
    const calls: Call[] = [];
    stub({ signature: SIG, initials: null }, calls);
    show();
    fireEvent.click(await screen.findByTestId('remove-signature'));
    fireEvent.click(await screen.findByTestId('confirm-remove-mark'));
    await waitFor(() => expect(screen.getByTestId('saved-signature')).toHaveTextContent('None saved'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/sign/me/signature'))).toBe(true);
  });

  it('M-A15 §5: turning off the offer on emailed links keeps the other settings', async () => {
    const calls: Call[] = [];
    stub({ signature: SIG, initials: null }, calls);
    show();
    const row = await screen.findByTestId('offer-on-links');
    expect(row).toHaveTextContent('pat@example.com');
    const box = row.querySelector('input') as HTMLInputElement;
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/v1/sign/me/settings'))).toBe(true));
    expect(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/v1/sign/me/settings'))?.body).toEqual({ date_format: 'DD/MM/YYYY', default_field_size: 'L', offer_saved_signature_on_links: false });
    expect(box).not.toBeChecked();
  });
});
