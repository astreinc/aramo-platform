import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_OFFER_COPY } from '@aramo/sign-client';

import { App } from './App.js';

// Aramo-Sign-Field-Test-Batch-1 §2 SIG-11, as amended by A1 (A1-7) — the web signing page and the
// server's profile_prefill. Email (sender-held) is pre-filled on open; Company, Title and the
// names are offers: "Fill from my profile" fills every empty one in one tap, a field's hint fills
// that field, and an offer not taken is never sent — not at Finish either (the leak regression).

vi.mock('./pdf-view.js', () => ({
  PdfDocument: ({ fields, onField, label }: { fields: { field_id: string }[]; onField: (f: unknown) => void; label: (f: unknown) => string }) => (
    <div data-testid="sg-pages">
      {fields.map((f) => (
        <button key={f.field_id} type="button" data-testid={`onpage-${f.field_id}`} onClick={() => onField(f)}>
          {label(f)}
        </button>
      ))}
    </div>
  ),
}));

const base = { document_id: 'doc-1', page_number: 0, x: 1, y: 1, width: 100, height: 20, condition: null };
type Field = Record<string, unknown> & { field_id: string };
const PREFILL = { FIRST_NAME: 'Priya', LAST_NAME: 'Raman', EMAIL: 'priya@example.com', COMPANY: 'Northwind', TITLE: 'Recruiter' };
const PROFILE_VALUES = ['Priya', 'Raman', 'Northwind', 'Recruiter'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function transport(fields: Field[], profile_prefill: unknown) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/v1/sign/signing/', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path === 'exchange') return json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' });
    if (path === 'disclosure-text') return json({ disclosure_version: 'v1', text: 'Consent text.', text_sha256: 'h'.repeat(64) });
    if (path === 'disclosure') return json({ accepted: true });
    if (path === 'document') return json({ documents: [{ document_id: 'doc-1', title: 'Vendor NDA', ordinal: 1 }], fields, date_format: 'MM/DD/YYYY', profile_prefill });
    if (path === 'source') return json({ source_base64: btoa('%PDF-1.4'), content_type: 'application/pdf' });
    if (path.startsWith('fields/')) return json({ filled: true });
    if (path === 'complete') return json({ envelope_status: 'COMPLETED' });
    if (path === 'qes/status') return json({ qes: null });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

const fills = (calls: { path: string; body: Record<string, unknown> }[]) =>
  calls.filter((c) => c.path.startsWith('fields/')).map((c) => ({ id: decodeURIComponent(c.path.split('/')[1] ?? ''), value: c.body['value'] }));

beforeEach(() => {
  window.history.pushState({}, '', '/s/tok-123');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:doc', revokeObjectURL: () => undefined }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function toWorkspace() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review document' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Agree & continue' }));
  await screen.findByTestId('sg-workspace');
}

const email: Field = { ...base, field_id: 'f-email', field_type: 'EMAIL', required: true, label: null };
const company: Field = { ...base, field_id: 'f-co', field_type: 'COMPANY', required: false, label: null };
const title: Field = { ...base, field_id: 'f-title', field_type: 'TITLE', required: false, label: null };

describe('profile values on the web signing page (SIG-11 + A1)', () => {
  it('on open: Email is pre-filled with the recipient email; Company and Title are empty and offered', async () => {
    const calls = transport([email, company, title], PREFILL);
    await toWorkspace();
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-email', value: 'priya@example.com' }]));
    expect(screen.getByTestId('sg-profile-fill')).toHaveTextContent(PROFILE_OFFER_COPY.banner);
    expect(screen.getByTestId('sg-offer-f-co')).toHaveTextContent(PROFILE_OFFER_COPY.hint('Northwind'));
    expect(screen.getByTestId('sg-offer-f-title')).toHaveTextContent(PROFILE_OFFER_COPY.hint('Recruiter'));
    expect(screen.queryByTestId('sg-offer-f-email')).toBeNull();
  });

  it('"Fill from my profile" fills only empty, visible, editable fields through the per-field fill; values stay editable', async () => {
    const locked: Field = { ...base, field_id: 'f-first', field_type: 'FIRST_NAME', required: false, label: null, read_only: true, value: 'Sender set' };
    const typed: Field = { ...title, filled: true, value: 'Typed title' };
    const hidden: Field = { ...base, field_id: 'f-last', field_type: 'LAST_NAME', required: false, label: null, condition: { trigger_key: 'k', when: 'checked' } };
    const trigger: Field = { ...base, field_id: 'f-k', field_type: 'CHECKBOX', required: false, label: 'More', field_key: 'k' };
    const calls = transport([company, typed, locked, hidden, trigger], PREFILL);
    await toWorkspace();
    fireEvent.click(screen.getByTestId('sg-profile-fill'));
    await screen.findByText(PROFILE_OFFER_COPY.filled(1));
    expect(fills(calls)).toEqual([{ id: 'f-co', value: 'Northwind' }]);
    expect(screen.queryByTestId('sg-profile-fill')).toBeNull();
    // Editable afterwards: the editor opens with the taken value.
    fireEvent.click(screen.getByTestId('onpage-f-co'));
    const dialog = await screen.findByRole('dialog', { name: 'Company' });
    expect(within(dialog).getByLabelText(/Company/)).toHaveValue('Northwind');
  });

  it('a field that becomes visible later is offered, never filled automatically', async () => {
    const hidden: Field = { ...base, field_id: 'f-last', field_type: 'LAST_NAME', required: false, label: null, condition: { trigger_key: 'k', when: 'checked' } };
    const trigger: Field = { ...base, field_id: 'f-k', field_type: 'CHECKBOX', required: false, label: 'More', field_key: 'k' };
    const calls = transport([hidden, trigger], PREFILL);
    await toWorkspace();
    expect(screen.queryByTestId('sg-offer-f-last')).toBeNull();
    fireEvent.click(screen.getByTestId('onpage-f-k'));
    await screen.findByTestId('sg-offer-f-last');
    expect(fills(calls)).toEqual([{ id: 'f-k', value: 'true' }]);
  });

  it('a field’s hint fills only that field', async () => {
    const calls = transport([company, title], PREFILL);
    await toWorkspace();
    fireEvent.click(screen.getByTestId('sg-offer-f-title'));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-title', value: 'Recruiter' }]));
    expect(screen.getByTestId('sg-offer-f-co')).toBeInTheDocument();
  });

  it('LEAK REGRESSION — Finish with offers not taken sends no profile value', async () => {
    const calls = transport([email, company, title], PREFILL);
    await toWorkspace();
    await screen.findAllByText('1 of 1 required fields filled');
    fireEvent.click(screen.getByRole('button', { name: 'Review & finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish signing' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'complete')).toBe(true));
    const sent = JSON.stringify(calls.map((c) => c.body));
    for (const v of PROFILE_VALUES) expect(sent).not.toContain(v);
    expect(fills(calls)).toEqual([{ id: 'f-email', value: 'priya@example.com' }]);
  });

  it('a required Company field blocks Finish until a value is entered or taken', async () => {
    transport([{ ...company, required: true }], PREFILL);
    await toWorkspace();
    expect(screen.queryByRole('button', { name: 'Review & finish' })).toBeNull();
    fireEvent.click(screen.getByTestId('sg-offer-f-co'));
    await screen.findByRole('button', { name: 'Review & finish' });
  });

  it('an emailed link, a hosted session or a guest (profile_prefill null): no banner, no hints, nothing pre-filled', async () => {
    const calls = transport([email, company, title], null);
    await toWorkspace();
    expect(screen.queryByTestId('sg-profile-fill')).toBeNull();
    expect(screen.queryByText(/Use from my profile/)).toBeNull();
    expect(fills(calls)).toEqual([]);
  });
});
