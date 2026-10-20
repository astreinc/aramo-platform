import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { fieldBox } from './field-geometry.js';

// The page renderer (pdfjs) cannot load under jsdom; this stand-in renders each
// field as an on-page button so the signing flow is still exercised end to end.
vi.mock('./pdf-view.js', () => ({
  PdfDocument: ({ fields, onField, actionLabel, label }: { fields: { field_id: string }[]; onField: (f: unknown) => void; actionLabel: (f: unknown) => string; label: (f: unknown) => string }) => (
    <div data-testid="sg-pages">
      {fields.map((f) => (
        <button key={f.field_id} type="button" data-testid="sg-onpage-field" onClick={() => onField(f)}>
          On page · {label(f)} ({actionLabel(f).length})
        </button>
      ))}
    </div>
  ),
}));

// The external signer app (signer handoff §5–§7; RTR signing storyboard) against
// a mocked signer transport: the full journey, decline, and each token state.
const VIEW = {
  documents: [{ document_id: 'doc-1', title: 'Right to Represent — Business Analyst', ordinal: 1 }],
  fields: [
    { field_id: 'f-init', document_id: 'doc-1', field_type: 'INITIALS', page_number: 1, x: 1, y: 1, width: 10, height: 10, required: true },
    { field_id: 'f-sig', document_id: 'doc-1', field_type: 'SIGNATURE', page_number: 2, x: 1, y: 1, width: 10, height: 10, required: true },
    { field_id: 'f-date', document_id: 'doc-1', field_type: 'SIGN_DATE', page_number: 2, x: 1, y: 2, width: 10, height: 10, required: true },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function transport(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/v1/sign/signing/', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const key = path.startsWith('fields/') ? 'fill' : path;
    const o = over[key];
    if (o) return o();
    if (path === 'exchange') return json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' });
    if (path === 'disclosure-text') return json({ disclosure_version: 'v1', text: 'By continuing you consent to sign this document electronically.', text_sha256: 'h'.repeat(64) });
    if (path === 'disclosure') return json({ accepted: true });
    if (path === 'document') return json(VIEW);
    if (path === 'source') return json({ source_base64: btoa('%PDF-1.4'), content_type: 'application/pdf' });
    if (key === 'fill') return json({ filled: true });
    if (path === 'complete') return json({ envelope_status: 'COMPLETED' });
    if (path === 'decline') return json({ declined: true });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

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
  const agree = screen.getByRole('button', { name: 'Agree & continue' });
  expect(agree).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(agree);
  await screen.findByTestId('sg-workspace');
}

describe('signer app', () => {
  it('lets a filled signature be changed until Finish signing', async () => {
    const calls = transport();
    await toWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.change(await screen.findByLabelText('Your initials'), { target: { value: 'RS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt & initial' }));
    await screen.findAllByText('1 of 3 required fields filled');
    fireEvent.click(screen.getByRole('button', { name: 'Next field' }));
    fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: 'Ravi Shankar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt & sign' }));
    await screen.findAllByText('2 of 3 required fields filled');
    // Change the filled signature: the adopt dialog reopens with the current name.
    fireEvent.click(screen.getByRole('button', { name: /^Change Signature/ }));
    const name = await screen.findByLabelText('Your full name');
    expect(name).toHaveValue('Ravi Shankar');
    fireEvent.change(name, { target: { value: 'Ravi S. Shankar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt & sign' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/fill') && JSON.stringify(c.body).includes('Ravi S. Shankar'))).toBe(true));
    await screen.findAllByText('2 of 3 required fields filled');
  });

  it('walks landing → disclosure → workspace → adopt → review → signed, with progress and no link into any Aramo app', async () => {
    const calls = transport();
    await toWorkspace();
    expect(screen.getAllByText('0 of 3 required fields filled').length).toBeGreaterThan(0);
    // Start → the first required field (initials) → adopt dialog (Type).
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adopt your initials' });
    fireEvent.change(screen.getByLabelText('Your initials'), { target: { value: 'RS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt & initial' }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await screen.findAllByText('1 of 3 required fields filled');
    // Next field → signature → adopt; then date applies with one tap.
    fireEvent.click(screen.getByRole('button', { name: 'Next field' }));
    fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: 'Ravi Shankar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt & sign' }));
    await screen.findAllByText('2 of 3 required fields filled');
    fireEvent.click(screen.getByRole('button', { name: 'Next field' }));
    await screen.findAllByText('3 of 3 required fields filled');
    fireEvent.click(screen.getByRole('button', { name: 'Review & finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish signing' }));
    expect(await screen.findByText(/You've signed Right to Represent/)).toBeInTheDocument();
    expect(screen.getByText(/Everyone has signed/)).toBeInTheDocument();
    expect(document.querySelectorAll('a')).toHaveLength(0);
    // The transport saw the disclosure acceptance and three fills with methods.
    expect(calls.some((c) => c.path === 'disclosure')).toBe(true);
    // A-7 — acceptance echoes the server-held version and hash, never a client constant.
    const accepted = calls.find((c) => c.path === 'disclosure')!.body;
    expect(accepted['disclosure_version']).toBe('v1');
    expect(accepted['disclosure_text_hash']).toBe('h'.repeat(64));
    const fills = calls.filter((c) => c.path.startsWith('fields/'));
    expect(fills.map((c) => c.path)).toEqual(['fields/f-init/fill', 'fields/f-sig/fill', 'fields/f-date/fill']);
    expect(fills[1]?.body['signature_method']).toBe('TYPED');
  });

  it('others still signing: the completion says so', async () => {
    transport({ complete: () => json({ envelope_status: 'IN_PROGRESS' }) });
    await toWorkspace();
    for (let i = 0; i < 3; i++) {
      const next = screen.queryByRole('button', { name: 'Start' }) ?? screen.getByRole('button', { name: 'Next field' });
      fireEvent.click(next);
      const d = screen.queryByRole('dialog');
      if (d) {
        const input = d.querySelector('input');
        if (input) fireEvent.change(input, { target: { value: 'Ravi Shankar' } });
        fireEvent.click(screen.getByRole('button', { name: /Adopt &/ }));
      }
      await screen.findAllByText(`${i + 1} of 3 required fields filled`);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Review & finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish signing' }));
    expect(await screen.findByText(/Others still need to sign/)).toBeInTheDocument();
  });

  it('decline requires a reason and a confirmation, then shows the declined screen', async () => {
    const calls = transport();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline to sign' }));
    const confirm = screen.getByRole('button', { name: 'Decline' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for declining'), { target: { value: 'Wrong rate' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('You declined to sign')).toBeInTheDocument();
    expect(calls.find((c) => c.path === 'decline')?.body).toMatchObject({ token: 'tok-123', reason: 'Wrong rate' });
  });

  it.each([
    ['SIGNING_SESSION_INVALID', 401, "This signing link isn't valid"],
    ['SIGNING_SESSION_EXPIRED', 401, 'This link is no longer active'],
    ['ENVELOPE_ALREADY_EXECUTED', 409, 'This document is no longer available to sign'],
    ['SIGNER_NOT_YET_ELIGIBLE', 409, "It's not your turn to sign yet"],
  ])('token state %s → its own screen with no navigation', async (code, status, heading) => {
    transport({ exchange: () => json({ error: { code } }, status) });
    render(<App />);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('opened without a token → Invalid link, no network call, never a sign-in page', () => {
    window.history.pushState({}, '', '/s/');
    const calls = transport();
    render(<App />);
    expect(screen.getByRole('heading', { name: "This signing link isn't valid" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  it('network failure on open → "We couldn\'t reach Aramo Sign" with Try again', async () => {
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (first) {
          first = false;
          throw new TypeError('offline');
        }
        return json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' });
      }) as unknown as typeof fetch,
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await act(async () => undefined);
    expect(await screen.findByRole('button', { name: 'Review document' })).toBeInTheDocument();
  });

  it('a failed field save keeps the other entries and says so', async () => {
    transport({ fill: () => json({ error: { code: 'INTERNAL_ERROR' } }, 500) });
    await toWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /Add date/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't save");
  });
});

describe('PX-2 field geometry', () => {
  it('maps a PDF bottom-left box to top-left page percentages', () => {
    const box = fieldBox({ field_type: 'SIGNATURE', x: 72, y: 144, width: 220, height: 48 }, { width: 612, height: 792 });
    expect(box.left).toBe(`${(72 / 612) * 100}%`);
    expect(box.top).toBe(`${((792 - 144 - 48) / 792) * 100}%`);
    expect(box.width).toBe(`${(220 / 612) * 100}%`);
  });
  it('uses the type default size when width/height are absent', () => {
    expect(fieldBox({ field_type: 'SIGN_DATE', x: 0, y: 0, width: null, height: null }, { width: 612, height: 792 }).height).toBe(`${(22 / 792) * 100}%`);
  });
});
