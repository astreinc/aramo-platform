import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { loadPdf } from '@aramo/document-templates-web/pdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { type SenderContext } from '../api';

// FIELD-PARITY-1 §5 P2-4 / P2-5 / P2-6 — sign-web hosts: the envelope document step offers the
// two upload options (a flag is sent only when ticked) and shows each opted-in upload's result;
// Prepare's "Find fields" asks the Sign route with detect=all and accepted ghosts are saved as
// ordinary fields for the recipient being placed for.

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
  documents: [{ id: 'd1', title: 'Lease', ordinal: 0, content_type: 'application/pdf', byte_size: 10, source_sha256: 'x', field_count: 0 }],
  recipients: [{ id: 's1', name: 'Sam Reed', email: 'sam@x.test', status: 'PENDING', signing_order: 1, viewed_at: null, signed_at: null, declined_at: null, decline_reason: null }],
  fields: [],
};
const UPLOADED = { id: 'd2', envelope_id: 'e1', title: 'Form', ordinal: 1, byte_size: 4, page_count: 1, pages: [{ width: 612, height: 792 }], revision: 2 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; url: string; body: unknown };
function stub(calls: Call[], uploadAnswer: unknown = UPLOADED) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/auth/sign/session')) return json(SESSION);
      if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
      if (url.endsWith('/envelopes/e1/documents') && method === 'POST') return json(uploadAnswer, 201);
      if (url.includes('/field-suggestions')) {
        return json({ suggestions: [{ type: 'SIGNATURE', page: 1, page_number: 0, x: 72, y: 100, width: 230, height: 50, reason: 'label:Signature', confidence: 0.95 }], skipped_pages: [] });
      }
      if (url.endsWith('/source')) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
      if (url.endsWith('/envelopes/e1/fields') && method === 'PUT') return json({ ...ENV, fields: (calls.at(-1)?.body as { fields: unknown[] }).fields });
      if (url.endsWith('/envelopes/e1')) return json(ENV);
      return json({ items: [], counts: {} });
    }),
  );
}

const show = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const pdfFile = () => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], 'form.pdf', { type: 'application/pdf' });

// PO ruling 2026-11-25 — the upload options belong to Document templates (the console form
// Studio), not to sending: the Send wizard offers none and uploads without the flags.
describe('sign-web document step — no upload options when sending', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('offers neither option; the upload body has no flag', async () => {
    const calls: Call[] = [];
    stub(calls);
    show('/sign/envelopes/e1/edit?step=1');
    const input = await screen.findByLabelText('Upload PDF documents');
    expect(screen.queryByTestId('docs-opt-import_fields')).toBeNull();
    expect(screen.queryByTestId('docs-opt-apply_text_tags')).toBeNull();
    expect(screen.queryByText('Import fields from a fillable PDF')).toBeNull();
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/documents'))).toBe(true));
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/documents'))!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['content_base64', 'filename', 'title']);
    expect(screen.queryByTestId('docs-import-result')).toBeNull();
    expect(screen.queryByTestId('attachments-removed')).toBeNull();
  });

  // PDF-ATTACH-1 ATT-8 — the shared notice when the server removed the PDF's attached files.
  it('says when the PDF’s attached files were removed (the shared words)', async () => {
    const calls: Call[] = [];
    stub(calls, { ...UPLOADED, attachments_removed: 1 });
    show('/sign/envelopes/e1/edit?step=1');
    const input = await screen.findByLabelText('Upload PDF documents');
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    const notice = await screen.findByTestId('attachments-removed');
    expect(notice.textContent).toContain('We removed 1 attached file from this PDF. Attached files can’t be signed, so they aren’t sent.');
  });

});

describe('sign-web Prepare — Find fields (P2-4)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('asks the Sign route with detect=all; an accepted ghost is saved as a field for the recipient', async () => {
    vi.mocked(loadPdf).mockResolvedValue({ pages: [{ width: 612, height: 792 }], render: async () => undefined, destroy: () => undefined } as never);
    const calls: Call[] = [];
    stub(calls);
    show('/sign/envelopes/e1/prepare');
    const find = await screen.findByTestId('prep-find-fields');
    await waitFor(() => expect(find).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(find);
    });
    expect(calls.some((c) => c.url.endsWith('/envelopes/e1/documents/d1/field-suggestions?detect=all'))).toBe(true);
    const ghost = await screen.findByTestId('prep-ghost-d1:0');
    fireEvent.click(ghost);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/envelopes/e1/fields'))).toBe(true), { timeout: 3000 });
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/envelopes/e1/fields'))!.body as { fields: Array<Record<string, unknown>> };
    expect(put.fields).toEqual([expect.objectContaining({ envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 230, height: 50, required: true })]);
  });
});
