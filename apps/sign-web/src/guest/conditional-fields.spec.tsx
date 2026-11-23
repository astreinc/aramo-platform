import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-6 —
// the signer page with conditional fields ("show only when"), against a mocked signer transport:
// fields appear and disappear live as the signer answers (list and page), progress and Next
// follow the shown fields only, a hidden answer is cleared as the server clears it, and a fill
// refused with field_hidden is worded.

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

const fieldsPanel = () => within(screen.getByRole('complementary', { name: 'Your fields' }));
const progressText = () => screen.getByRole('complementary', { name: 'Your fields' }).querySelector('[aria-live="polite"]')?.textContent;

// "Add a co-applicant" (optional box, key co) shows "Co-applicant agrees" (a required box) and,
// one level down, the co-applicant's office (a required dropdown); the signature is always shown.
const co: Field = { ...base, field_id: 'f-co', field_key: 'co', field_type: 'CHECKBOX', required: false, label: 'Add a co-applicant', condition: null };
const agrees: Field = {
  ...base,
  field_id: 'f-agrees',
  field_key: 'agrees',
  field_type: 'CHECKBOX',
  required: true,
  label: 'Co-applicant agrees',
  condition: { trigger_key: 'co', when: 'checked' },
};
const office: Field = {
  ...base,
  field_id: 'f-office',
  field_key: 'office',
  field_type: 'DROPDOWN',
  required: true,
  label: 'Co-applicant office',
  options: { choices: [{ value: 'nyc', label: 'New York' }, { value: 'blr', label: 'Bengaluru' }] },
  condition: { trigger_key: 'agrees', when: 'checked' },
};
const sig: Field = { ...base, field_id: 'f-sig', field_key: 'sig', field_type: 'SIGNATURE', required: true, label: null, condition: null };

describe('B-6 conditional fields on the signer page', () => {
  it('a dependent field appears when its trigger is checked and disappears when it is unchecked (list and page)', async () => {
    const calls = transport([co, agrees, office, sig]);
    await toWorkspace();
    // Hidden: not drawn on the page, not listed, not counted.
    expect(screen.getByTestId('onpage-f-co')).toBeInTheDocument();
    expect(screen.queryByTestId('onpage-f-agrees')).toBeNull();
    expect(screen.queryByTestId('onpage-f-office')).toBeNull();
    expect(fieldsPanel().queryByText('Co-applicant agrees')).toBeNull();
    expect(progressText()).toBe('0 of 1 required fields filled');

    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: Add a co-applicant, page 1' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-co', value: 'true' }]));
    expect(await screen.findByTestId('onpage-f-agrees')).toBeInTheDocument();
    expect(fieldsPanel().getByRole('button', { name: 'Check: Co-applicant agrees, page 1' })).toBeInTheDocument();
    // One level down stays hidden until its own trigger is met (a chain).
    expect(screen.queryByTestId('onpage-f-office')).toBeNull();
    expect(progressText()).toBe('0 of 2 required fields filled');

    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: Co-applicant agrees, page 1' }));
    expect(await screen.findByTestId('onpage-f-office')).toBeInTheDocument();
    expect(progressText()).toBe('1 of 3 required fields filled');

    // Unchecking the top trigger hides the whole chain again.
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Uncheck: Add a co-applicant, page 1' }));
    await waitFor(() => expect(screen.queryByTestId('onpage-f-agrees')).toBeNull());
    expect(screen.queryByTestId('onpage-f-office')).toBeNull();
    expect(fieldsPanel().queryByText('Co-applicant agrees')).toBeNull();
    expect(progressText()).toBe('0 of 1 required fields filled');
  });

  it('an answer that hides fields clears them on the page too (as the server does); shown again, they start empty', async () => {
    const calls = transport([co, agrees, sig]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: Add a co-applicant, page 1' }));
    fireEvent.click(await fieldsPanel().findByRole('button', { name: 'Check: Co-applicant agrees, page 1' }));
    await waitFor(() => expect(fieldsPanel().getByRole('button', { name: 'Uncheck: Co-applicant agrees, page 1' })).toBeInTheDocument());
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Uncheck: Add a co-applicant, page 1' }));
    await waitFor(() => expect(screen.queryByTestId('onpage-f-agrees')).toBeNull());
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: Add a co-applicant, page 1' }));
    // Shown again: the box is unchecked (its answer was cleared), and nothing was sent for it.
    expect(await fieldsPanel().findByRole('button', { name: 'Check: Co-applicant agrees, page 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(fills(calls).filter((c) => c.id === 'f-agrees')).toEqual([{ id: 'f-agrees', value: 'true' }]);
  });

  it('Next skips hidden fields: with the trigger unchecked, Start goes to the signature', async () => {
    transport([co, agrees, sig]);
    await toWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    // The signature opens its adopt dialog (the hidden box is never offered).
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a hidden field is never focusable (it is not rendered)', async () => {
    transport([co, agrees, sig]);
    await toWorkspace();
    expect(document.getElementById('sg-act-f-agrees')).toBeNull();
    expect(screen.queryByRole('button', { name: /Co-applicant agrees/ })).toBeNull();
  });

  it('a fill refused with field_hidden is worded', async () => {
    transport([co, sig], {
      fill: () => json({ error: { code: 'VALIDATION_ERROR', message: 'This field is not shown for your answers', details: { reason: 'field_hidden' } } }, 400),
    });
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: Add a co-applicant, page 1' }));
    expect(await screen.findByText('This field isn’t needed for your answers, so it’s hidden now.')).toBeInTheDocument();
  });
});
