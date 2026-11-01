import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

// Consolidated Directive v1.0 B3 — the signer's delegation hand-off and the qualified-signature
// step (with its /qes/callback return page), plus the SMS code the sender may require (B2).

vi.mock('./pdf-view.js', () => ({
  PdfDocument: () => <div data-testid="sg-pages" />,
}));

const FIELD = { field_id: 'f-sig', document_id: 'doc-1', field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true };
const VIEW = { documents: [{ document_id: 'doc-1', title: 'Offer letter', ordinal: 1 }], fields: [FIELD] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function transport(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/v1/sign/signing/', '');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const key = path.startsWith('fields/') ? 'fill' : path;
      const o = over[key];
      if (o) return o();
      if (path === 'exchange') return json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' });
      if (path === 'disclosure-text') return json({ disclosure_version: 'v1', text: 'Consent text.', text_sha256: 'h'.repeat(64) });
      if (path === 'disclosure') return json({ accepted: true });
      if (path === 'document') return json(VIEW);
      if (path === 'source') return json({ source_base64: btoa('%PDF-1.4'), content_type: 'application/pdf' });
      if (path === 'qes/status') return json({ error: { code: 'ESIGN_FEATURE_NOT_AVAILABLE' } }, 403);
      if (key === 'fill') return json({ filled: true });
      if (path === 'complete') return json({ envelope_status: 'COMPLETED' });
      return json({}, 404);
    }) as unknown as typeof fetch,
  );
  return calls;
}

async function toWorkspace() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review document' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Agree & continue' }));
  await screen.findByTestId('sg-workspace');
}

async function signAndReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: 'Ravi Shankar' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt & sign' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review & finish' }));
  await screen.findByTestId('sg-review');
}

beforeEach(() => {
  window.history.pushState({}, '', '/s/tok-123');
  window.sessionStorage.clear();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:doc', revokeObjectURL: () => undefined }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delegation (Feature-Parity §1.17)', () => {
  it('is not offered unless the document view says the signer may hand it off', async () => {
    transport();
    await toWorkspace();
    expect(screen.queryByTestId('sg-delegate')).toBeNull();
  });

  it('hands the signature to another person; this link then shows the hand-off', async () => {
    const calls = transport({ document: () => json({ ...VIEW, can_delegate: true }), delegate: () => json({ delegated: true }) });
    await toWorkspace();
    fireEvent.click(screen.getByTestId('sg-delegate'));
    const send = screen.getByRole('button', { name: 'Send to them' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Their full name'), { target: { value: 'Dana Cole' } });
    fireEvent.change(screen.getByLabelText('Their email'), { target: { value: 'dana@x.test' } });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'On leave' } });
    fireEvent.click(send);
    expect(await screen.findByRole('heading', { name: 'Sent to Dana Cole' })).toBeInTheDocument();
    expect(screen.getByText(/This link no longer works for you/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === 'delegate')?.body).toEqual({ token: 'tok-123', name: 'Dana Cole', email: 'dana@x.test', reason: 'On leave' });
  });

  it('a refusal is explained in the dialog', async () => {
    transport({
      document: () => json({ ...VIEW, can_delegate: true }),
      delegate: () => json({ error: { code: 'VALIDATION_ERROR', details: { reason: 'delegate_email_on_envelope' } } }, 400),
    });
    await toWorkspace();
    fireEvent.click(screen.getByTestId('sg-delegate'));
    fireEvent.change(screen.getByLabelText('Their full name'), { target: { value: 'Dana Cole' } });
    fireEvent.change(screen.getByLabelText('Their email'), { target: { value: 'dana@x.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to them' }));
    expect(await screen.findByText('That person is already on this document.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Ask someone else to sign' })).toBeInTheDocument();
  });
});

describe('qualified electronic signature (Feature-Parity §1.16)', () => {
  it('not required (or not available): Finish is not held back', async () => {
    transport();
    await toWorkspace();
    await signAndReview();
    expect(screen.queryByTestId('sg-qes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Finish signing' })).toBeEnabled();
  });

  it('required: Finish waits; Continue keeps the token in this tab and opens the provider', async () => {
    const calls = transport({
      'qes/status': () => json({ qes: { signature_level: 'QES', state: 'REQUIRED', provider: 'TrustCo', failure_reason: null } }),
      'qes/begin': () => json({ state: 'IDENTITY_PROOFING_PENDING', redirect_url: 'https://qtsp.example/oauth?state=x' }),
    });
    await toWorkspace();
    await signAndReview();
    expect(screen.getByTestId('sg-qes')).toHaveTextContent('TrustCo');
    expect(screen.getByRole('button', { name: 'Finish signing' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to sign' }));
    await waitFor(() => expect(window.sessionStorage.getItem('aramo-sign-qes-token')).toBe('tok-123'));
    expect(calls.find((c) => c.path === 'qes/begin')?.body).toEqual({ token: 'tok-123' });
  });

  it('a provider address that is not https is never followed', async () => {
    transport({
      'qes/status': () => json({ qes: { signature_level: 'QES', state: 'FAILED', provider: null, failure_reason: 'qtsp_unreachable' } }),
      'qes/begin': () => json({ state: 'IDENTITY_PROOFING_PENDING', redirect_url: 'javascript:alert(1)' }),
    });
    await toWorkspace();
    await signAndReview();
    expect(screen.getByText(/The last attempt didn't finish/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByText(/The qualified signature was not completed/)).not.toHaveLength(0);
    expect(window.sessionStorage.getItem('aramo-sign-qes-token')).toBeNull();
  });

  it('/qes/callback completes the step with the token kept in this tab', async () => {
    window.sessionStorage.setItem('aramo-sign-qes-token', 'tok-123');
    window.history.pushState({}, '', '/qes/callback?code=c-1&state=st-1');
    const calls = transport({ 'qes/complete': () => json({ state: 'AUTHORIZED', redirect_url: 'https://qtsp.example/sign' }) });
    render(<App />);
    expect(await screen.findByTestId('sg-qes-callback')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path === 'qes/complete')).toHaveLength(1));
    expect(calls.find((c) => c.path === 'qes/complete')?.body).toEqual({ token: 'tok-123', code: 'c-1', state: 'st-1' });
    // The callback page never opens a signing session of its own.
    expect(calls.some((c) => c.path === 'exchange')).toBe(false);
  });

  it('/qes/callback: a provider error or a missing token is explained, nothing is sent', async () => {
    window.sessionStorage.setItem('aramo-sign-qes-token', 'tok-123');
    window.history.pushState({}, '', '/qes/callback?error=access_denied');
    const calls = transport();
    render(<App />);
    expect(await screen.findByText(/The qualified signature was not completed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the document' })).toBeInTheDocument();
    cleanup();
    window.sessionStorage.clear();
    window.history.pushState({}, '', '/qes/callback?code=c&state=s');
    render(<App />);
    expect(await screen.findByText(/This page has expired/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === 'qes/complete')).toBe(false);
  });
});

describe('SMS code before the document opens (Feature-Parity §1.9)', () => {
  it('texts a code, refuses a wrong one, then opens the document', async () => {
    let verified = false;
    const calls = transport({
      exchange: () =>
        verified
          ? json({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' })
          : json({ error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'recipient_verification_required' } } }, 403),
      verification: () => json({ required: true, verified: false, locked: false, phone: '+1•••••••23' }),
      'verification/sms-otp/send': () => json({ sent: true, verified: false, phone: '+1•••••••23' }),
      'verification/sms-otp/verify': () => {
        if (calls.filter((c) => c.path === 'verification/sms-otp/verify').length === 1) {
          return json({ error: { code: 'VALIDATION_ERROR', details: { reason: 'otp_mismatch' } } }, 400);
        }
        verified = true;
        return json({ verified: true });
      },
    });
    render(<App />);
    expect(await screen.findByTestId('sg-sms-code')).toBeInTheDocument();
    expect(await screen.findByText(/\+1•••••••23/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("That code isn't right. Check it and try again.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Review document' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === 'verification/sms-otp/verify').map((c) => c.body['code'])).toEqual(['000000', '123456']);
  });

  it('locked out → its own end screen', async () => {
    transport({ exchange: () => json({ error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'recipient_verification_locked' } } }, 403) });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Too many incorrect codes' })).toBeInTheDocument();
  });
});
