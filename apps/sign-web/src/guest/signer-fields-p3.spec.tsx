import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 — the
// signer page with the Phase 3 types (DATE, DROPDOWN, RADIO, NUMBER, MULTILINE_TEXT,
// ACKNOWLEDGEMENT) and settings (label, tooltip, placeholder, read_only + sender_filled,
// validation presets), against a mocked signer transport.

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

describe('T-3 DATE', () => {
  const date: Field = {
    ...base,
    field_id: 'f-date',
    field_type: 'DATE',
    required: true,
    label: 'Start date',
    tooltip: 'Your first working day',
    validation: 'date_range',
    options: { min_date: '2026-01-01', max_date: '2026-12-31' },
  };

  it('a date picker inside the range; stored YYYY-MM-DD; shown in the envelope date format', async () => {
    const calls = transport([date], { date_format: 'DD/MM/YYYY' });
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Choose date: Start date, page 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start date' });
    const input = within(dialog).getByLabelText('Start date');
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveAttribute('min', '2026-01-01');
    expect(input).toHaveAttribute('max', '2026-12-31');
    expect(within(dialog).getByText('Your first working day')).toBeInTheDocument();
    expect(within(dialog).getByText('From 01/01/2026 to 31/12/2026')).toBeInTheDocument();
    // Outside the range: named inline, announced, the input marked invalid; nothing is sent.
    fireEvent.change(input, { target: { value: '2025-06-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a date from 01/01/2026 to 31/12/2026.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('-err');
    expect(document.activeElement).toBe(input);
    expect(fills(calls)).toEqual([]);
    fireEvent.change(input, { target: { value: '2026-03-04' } });
    expect(within(dialog).getByTestId('sg-date-preview')).toHaveTextContent('Shown on the document as 04/03/2026');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-date', value: '2026-03-04' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('onpage-f-date')).toHaveTextContent('Start date: 04/03/2026');
  });
});

describe('T-6 NUMBER', () => {
  it('money prefix, decimal keypad, typing normalised; shown as money', async () => {
    const money: Field = {
      ...base,
      field_id: 'f-amt',
      field_type: 'NUMBER',
      required: true,
      label: 'Salary',
      placeholder: '0.00',
      validation: 'number_range',
      options: { format: 'money', currency: 'USD', decimals: 2, min: 1, max: 500000 },
    };
    const calls = transport([money]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Enter number: Salary, page 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salary' });
    const input = within(dialog).getByLabelText('Salary');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveAttribute('placeholder', '0.00');
    expect(within(dialog).getByText('$')).toBeInTheDocument();
    expect(within(dialog).getByText('Amount in USD · From $1.00 to $500,000.00')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '12.345' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use at most 2 decimal places.');
    fireEvent.change(input, { target: { value: '$1,250.5' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-amt', value: '1250.5' }]));
    await waitFor(() => expect(screen.getByTestId('onpage-f-amt')).toHaveTextContent('Salary: $1,250.50'));
  });
});

describe('T-4 DROPDOWN', () => {
  it('the sender’s choices; the value is the choice’s value, shown as its label', async () => {
    const dd: Field = {
      ...base,
      field_id: 'f-dd',
      field_type: 'DROPDOWN',
      required: true,
      label: 'Office',
      placeholder: 'Pick an office',
      options: { choices: [{ value: 'nyc', label: 'New York' }, { value: 'blr', label: 'Bengaluru' }] },
    };
    const calls = transport([dd]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Choose: Office, page 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Office' });
    const select = within(dialog).getByRole('combobox', { name: 'Office' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick an office', 'New York', 'Bengaluru']);
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'blr' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-dd', value: 'blr' }]));
    await waitFor(() => expect(screen.getByTestId('onpage-f-dd')).toHaveTextContent('Office: Bengaluru'));
  });
});

describe('T-7 MULTILINE_TEXT', () => {
  it('a multi-line input with a max_length counter', async () => {
    const ml: Field = { ...base, field_id: 'f-ml', field_type: 'MULTILINE_TEXT', required: false, label: 'Notes', validation: 'max_length', options: { max_length: 50 } };
    const calls = transport([ml]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Enter text: Notes, page 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notes' });
    const area = within(dialog).getByLabelText('Notes (optional)');
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveAttribute('maxlength', '50');
    expect(within(dialog).getByTestId('sg-count')).toHaveTextContent('0 / 50');
    fireEvent.change(area, { target: { value: 'Line one\nLine two' } });
    expect(within(dialog).getByTestId('sg-count')).toHaveTextContent('17 / 50');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-ml', value: 'Line one\nLine two' }]));
  });
});

describe('T-5 RADIO', () => {
  const opt = (id: string, label: string, required = true): Field => ({ ...base, field_id: id, field_type: 'RADIO', required, label, group_key: 'g1', group_rule: 'SELECT_ONE' });

  it('one per option; choosing one clears the others; a required group needs one', async () => {
    const calls = transport([opt('r-a', 'Full time'), opt('r-b', 'Part time')]);
    await toWorkspace();
    expect(screen.getAllByText('0 of 1 required fields filled').length).toBeGreaterThan(0);
    const a = fieldsPanel().getByRole('radio', { name: 'Choose: Full time, page 1' });
    const b = fieldsPanel().getByRole('radio', { name: 'Choose: Part time, page 1' });
    expect(a).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(a);
    await waitFor(() => expect(fieldsPanel().getByRole('radio', { name: 'Chosen: Full time, page 1' })).toHaveAttribute('aria-checked', 'true'));
    await screen.findAllByText('1 of 1 required fields filled');
    fireEvent.click(b);
    await waitFor(() => expect(fieldsPanel().getByRole('radio', { name: 'Chosen: Part time, page 1' })).toHaveAttribute('aria-checked', 'true'));
    expect(fieldsPanel().getByRole('radio', { name: 'Choose: Full time, page 1' })).toHaveAttribute('aria-checked', 'false');
    // The server clears the group's other options: the page sends only the choice.
    expect(fills(calls)).toEqual([
      { id: 'r-a', value: 'true' },
      { id: 'r-b', value: 'true' },
    ]);
    // Choosing the chosen option again changes nothing.
    fireEvent.click(fieldsPanel().getByRole('radio', { name: 'Chosen: Part time, page 1' }));
    expect(fills(calls)).toHaveLength(2);
  });

  it('FIELD-PARITY-2 A-2: tapping the chosen option of an optional set clears it', async () => {
    const calls = transport([opt('r-a', 'Full time', false), opt('r-b', 'Part time', false)]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('radio', { name: 'Choose: Full time, page 1' }));
    await waitFor(() => expect(fieldsPanel().getByRole('radio', { name: 'Chosen: Full time, page 1' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(fieldsPanel().getByRole('radio', { name: 'Chosen: Full time, page 1' }));
    await waitFor(() => expect(fieldsPanel().getByRole('radio', { name: 'Choose: Full time, page 1' })).toHaveAttribute('aria-checked', 'false'));
    expect(fills(calls)).toEqual([
      { id: 'r-a', value: 'true' },
      { id: 'r-a', value: 'false' },
    ]);
  });

  it('a refused Finish (radio_group_select_one) is named and announced, and focus moves to it', async () => {
    transport([opt('r-a', 'Full time', false), opt('r-b', 'Part time', false)], {
      complete: () => json({ error: { code: 'SIGNATURE_FIELD_INCOMPLETE', details: { reason: 'radio_group_select_one' } } }, 409),
    });
    await toWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Review & finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish signing' }));
    const notice = await screen.findByText('Choose exactly one option in each set of choices.');
    expect(notice).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it('with a required choice still open, Start moves focus to the group’s first option', async () => {
    transport([opt('r-a', 'Full time'), opt('r-b', 'Part time'), { ...base, field_id: 'f-t', field_type: 'TEXT', required: false }]);
    await toWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Choose: Full time, page 1' })));
  });
});

describe('T-2 ACKNOWLEDGEMENT (now authorable)', () => {
  it('a required acknowledgement is checked by the signer', async () => {
    const calls = transport([{ ...base, field_id: 'f-ack', field_type: 'ACKNOWLEDGEMENT', required: true, label: 'I have read the handbook' }]);
    await toWorkspace();
    expect(screen.getAllByText('0 of 1 required fields filled').length).toBeGreaterThan(0);
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Check: I have read the handbook, page 1' }));
    await waitFor(() => expect(fills(calls)).toEqual([{ id: 'f-ack', value: 'true' }]));
    await screen.findAllByText('1 of 1 required fields filled');
  });
});

describe('S-4 / S-5 read-only sender values', () => {
  it('shown, never editable, never sent, and never block Finish', async () => {
    const calls = transport([
      { ...base, field_id: 'f-ref', field_type: 'TEXT', required: true, label: 'Reference', read_only: true, sender_filled: true, filled: true, value: 'ACME-42' },
      { ...base, field_id: 'f-when', field_type: 'DATE', required: true, label: 'Effective date', read_only: true, sender_filled: true, filled: true, value: '2026-05-01' },
      { ...base, field_id: 'f-sig', field_type: 'SIGNATURE', required: false },
    ]);
    await toWorkspace();
    const rows = screen.getAllByTestId('sg-sender-value');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('ACME-42 · filled in by the sender');
    expect(rows[1]).toHaveTextContent('05/01/2026 · filled in by the sender');
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    // Tapping the box on the page does nothing.
    fireEvent.click(screen.getByTestId('onpage-f-ref'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing is required of the signer: Finish is offered straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Review & finish' }));
    expect(await screen.findByTestId('sg-review')).toHaveTextContent('Filled in by the sender');
    fireEvent.click(screen.getByRole('button', { name: 'Finish signing' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'complete')).toBe(true));
    expect(fills(calls)).toEqual([]);
  });
});

describe('S-1 label / tooltip and S-6 server refusals', () => {
  it('the label names the field, the tooltip describes its action; a server refusal stays in the editor in plain language', async () => {
    const calls = transport([{ ...base, field_id: 'f-ph', field_type: 'TEXT', required: true, label: 'Mobile number', tooltip: 'We text you once', validation: 'phone' }], {
      fill: () => json({ error: { code: 'VALIDATION_ERROR', message: 'internal wording', details: { reason: 'validation_phone_failed', field_id: 'f-ph' } } }, 400),
    });
    await toWorkspace();
    const btn = fieldsPanel().getByRole('button', { name: 'Enter text: Mobile number, page 1' });
    expect(btn).toHaveAccessibleDescription('We text you once');
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: 'Mobile number' });
    const input = within(dialog).getByLabelText('Mobile number');
    expect(input).toHaveAttribute('type', 'tel');
    fireEvent.change(input, { target: { value: '+1 415 555 0100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a valid phone number, with 7 to 15 digits.');
    expect(screen.queryByText('internal wording')).toBeNull();
    expect(fills(calls)).toHaveLength(1);
  });

  it('a client check catches a preset before anything is sent (email)', async () => {
    const calls = transport([{ ...base, field_id: 'f-em', field_type: 'TEXT', required: true, label: 'Work email', validation: 'email' }]);
    await toWorkspace();
    fireEvent.click(fieldsPanel().getByRole('button', { name: 'Enter text: Work email, page 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Work email' });
    fireEvent.change(within(dialog).getByLabelText('Work email'), { target: { value: 'not-an-email' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a valid email address, like name@example.com.');
    expect(fills(calls)).toEqual([]);
  });
});
