import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { type SenderContext } from '../api';

// WEB-WORD-1 (LOCKED 2026-11-27) — Sign web accepts .docx / .doc while the sender context reports
// word_conversion_enabled (the server converts to PDF, as for the app); otherwise PDF only.

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'], iat: 0, exp: 9_999_999_999 };
const BASE_CTX: SenderContext = {
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
  documents: [],
  recipients: [],
  fields: [],
};
const UPLOADED = { id: 'd2', envelope_id: 'e1', title: 'Offer', ordinal: 0, byte_size: 4, page_count: 1, pages: [{ width: 612, height: 792 }], revision: 2 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; url: string; body: unknown };
function stub(calls: Call[], ctx: SenderContext) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(ctx);
      if (url.endsWith('/envelopes/e1/documents') && method === 'POST') return json(UPLOADED, 201);
      if (url.endsWith('/envelopes/e1')) return json(ENV);
      return json({ items: [], counts: {} });
    }),
  );
}

const show = () =>
  render(
    <MemoryRouter initialEntries={['/sign/envelopes/e1/edit?step=1']}>
      <App />
    </MemoryRouter>,
  );

// A .docx is a ZIP: it starts with "PK\x03\x04".
const docxFile = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])], 'Offer.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
const pdfFile = () => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], 'form.pdf', { type: 'application/pdf' });
const uploads = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/documents'));

describe('WEB-WORD-1 — Word upload on Sign web', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('while the server converts Word: the picker takes Word and a .docx is uploaded by its name', async () => {
    const calls: Call[] = [];
    stub(calls, { ...BASE_CTX, word_conversion_enabled: true } as SenderContext);
    show();
    const input = await screen.findByLabelText('Upload PDF or Word documents');
    expect(input.getAttribute('accept')).toContain('.docx');
    expect(input.getAttribute('accept')).toContain('.doc');
    expect(screen.getByText('PDF up to 25 MB, Word (.docx, .doc) up to 20 MB, converted to PDF')).toBeTruthy();
    fireEvent.change(input, { target: { files: [docxFile()] } });
    await waitFor(() => expect(uploads(calls)).toHaveLength(1));
    expect(uploads(calls)[0]!.body).toMatchObject({ filename: 'Offer.docx', title: 'Offer' });
  });

  it('a PDF is unchanged while Word is on', async () => {
    const calls: Call[] = [];
    stub(calls, { ...BASE_CTX, word_conversion_enabled: true } as SenderContext);
    show();
    fireEvent.change(await screen.findByLabelText('Upload PDF or Word documents'), { target: { files: [pdfFile()] } });
    await waitFor(() => expect(uploads(calls)).toHaveLength(1));
    expect(uploads(calls)[0]!.body).toMatchObject({ filename: 'form.pdf' });
  });

  it('while the server does not convert Word: PDF only, and a Word file is refused with the shared words', async () => {
    const calls: Call[] = [];
    stub(calls, BASE_CTX);
    show();
    const input = await screen.findByLabelText('Upload PDF documents');
    expect(input.getAttribute('accept')).not.toContain('.docx');
    expect(screen.getByText('PDF files up to 25 MB each')).toBeTruthy();
    fireEvent.change(input, { target: { files: [docxFile()] } });
    expect(await screen.findByText(/Offer\.docx: Word files can’t be sent\. Save the document as a PDF, then choose the PDF\./)).toBeTruthy();
    expect(uploads(calls)).toHaveLength(0);
  });
});
