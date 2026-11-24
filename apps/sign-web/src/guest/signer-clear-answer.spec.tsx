import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

// FIELD-PARITY-2 B-6 follow-up (ruling C-3) — a signer clears a saved answer on the web signing
// page: emptying the field editor offers "Clear answer", which sends value null (the server's
// clear, the shared rule @aramo/sign-client signerClearRefusal). Sign web test 5: save, reopen,
// clear, reopen, finish with the optional field empty.

// pdfjs cannot load under jsdom: each field is an on-page button that also shows what the box
// displays once filled (the value as the executed PDF prints it).
vi.mock('./pdf-view.js', () => ({
  PdfDocument: ({
    fields,
    onField,
    label,
    display,
  }: {
    fields: { field_id: string }[];
    onField: (f: unknown) => void;
    label: (f: unknown) => string;
    display: (f: unknown) => { value: string } | null;
  }) => (
    <div data-testid="sg-pages">
      {fields.map((f) => (
        <button key={f.field_id} type="button" data-testid={`onpage-${f.field_id}`} onClick={() => onField(f)}>
          {label(f)}: {display(f)?.value ?? ''}
        </button>
      ))}
    </div>
  ),
}));

const base = { document_id: 'doc-1', page_number: 0, x: 1, y: 1, width: 100, height: 20 };
type Field = Record<string, unknown> & { field_id: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function transport(fields: Field[], over: { fill?: (body: Record<string, unknown>, path: string) => Response | null; complete?: () => Response; date_format?: string | null } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/v1/sign/signing/', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path === 'exchange') return json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' });
    if (path === 'disclosure-text') return json({ disclosure_version: 'v1', text: 'Consent text.', text_sha256: 'h'.repeat(64) });
    if (path === 'disclosure') return json({ accepted: true });
    if (path === 'document')
      return json({ documents: [{ document_id: 'doc-1', title: 'Onboarding form', ordinal: 1 }], fields, date_format: over.date_format === undefined ? 'MM/DD/YYYY' : over.date_format });
    if (path === 'source') return json({ source_base64: btoa('%PDF-1.4'), content_type: 'application/pdf' });
    if (path.startsWith('fields/')) return over.fill?.(body, path) ?? json({ filled: true });
    if (path === 'complete') return over.complete?.() ?? json({ envelope_status: 'COMPLETED' });
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

const openOnPage = async (id: string, name: string) => {
  fireEvent.click(screen.getByTestId(`onpage-${id}`));
  return screen.findByRole('dialog', { name });
};

const note: Field = { ...base, field_id: 'f-note', field_key: 'note', field_type: 'TEXT', required: false, label: 'Note', condition: null };
const sig: Field = { ...base, field_id: 'f-sig', field_key: 'sig', field_type: 'SIGNATURE', required: true, label: null, condition: null };

describe('clearing a saved answer (web signing page)', () => {
  it('a saved answer reopens filled; emptied, "Clear answer" sends null and the field is empty again', async () => {
    // Reopening the link: the server returns the signer's saved answer.
    const calls = transport([{ ...note, filled: true, value: 'Test answer' }, sig]);
    await toWorkspace();
    expect(screen.getByTestId('onpage-f-note')).toHaveTextContent('Note: Test answer');
    const dialog = await openOnPage('f-note', 'Note');
    const input = within(dialog).getByLabelText(/Note/);
    expect(input).toHaveValue('Test answer');
    expect(within(dialog).queryByRole('button', { name: 'Clear answer' })).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear answer' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-note', value: null }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Note' })).toBeNull());
    expect(screen.getByTestId('onpage-f-note')).toHaveTextContent(/^Note:$/);
  });

  it('a field with nothing saved keeps Apply disabled while empty (nothing to clear)', async () => {
    const calls = transport([note, sig]);
    await toWorkspace();
    const dialog = await openOnPage('f-note', 'Note');
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Clear answer' })).toBeNull();
    expect(fills(calls)).toEqual([]);
  });

  it('a saved dropdown choice can be cleared by picking the empty entry', async () => {
    const dd: Field = {
      ...base,
      field_id: 'f-dd',
      field_key: 'dd',
      field_type: 'DROPDOWN',
      required: false,
      label: 'Office',
      options: { choices: [{ value: 'nyc', label: 'New York' }, { value: 'blr', label: 'Bengaluru' }] },
      filled: true,
      value: 'blr',
    };
    const calls = transport([dd, sig]);
    await toWorkspace();
    const dialog = await openOnPage('f-dd', 'Office');
    const select = within(dialog).getByRole('combobox', { name: /Office/ });
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear answer' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-dd', value: null }]));
  });

  it('a refused clear stays in the editor with its message', async () => {
    const calls = transport([{ ...note, filled: true, value: 'Test answer' }, sig], {
      fill: () => json({ code: 'VALIDATION_ERROR', message: 'raw', details: { reason: 'field_clear_not_allowed' } }, 400),
    });
    await toWorkspace();
    const dialog = await openOnPage('f-note', 'Note');
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear answer' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-note', value: null }]));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });
});
