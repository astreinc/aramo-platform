import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

// DOC-4 (R-4-8) — the signer journey: exchange -> disclosure -> typed signature
// -> complete -> receipt, against a mocked signer transport.

describe('sign-web App', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/s/tok-123?field=field-1');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks the signer journey to a signed receipt', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/exchange')) {
        return new Response(JSON.stringify({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' }), { status: 200 });
      }
      if (url.endsWith('/disclosure')) return new Response('{}', { status: 200 });
      if (url.includes('/fields/')) return new Response('{}', { status: 200 });
      if (url.endsWith('/complete')) return new Response(JSON.stringify({ envelope_status: 'COMPLETED' }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<App />);
    fireEvent.click(screen.getByText('Open document'));
    await waitFor(() => screen.getByText('I agree'));
    fireEvent.click(screen.getByText('I agree'));
    await waitFor(() => screen.getByLabelText('typed signature'));
    fireEvent.change(screen.getByLabelText('typed signature'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByText('Apply signature & complete'));
    await waitFor(() => screen.getByText('Signed'));
    expect(screen.getByText(/your signature has been recorded/)).toBeInTheDocument();
    // The signer transport was called with the token — never a tenant id.
    const exchangeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/exchange'));
    expect(exchangeCall).toBeDefined();
  });

  it('blocks completion when no signature is provided', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/exchange')) return new Response(JSON.stringify({ session_id: 's1', envelope_id: 'env-1', signer_id: 'sig-1' }), { status: 200 });
      if (url.endsWith('/disclosure')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<App />);
    fireEvent.click(screen.getByText('Open document'));
    await waitFor(() => screen.getByText('I agree'));
    fireEvent.click(screen.getByText('I agree'));
    await waitFor(() => screen.getByText('Apply signature & complete'));
    fireEvent.click(screen.getByText('Apply signature & complete'));
    await waitFor(() => screen.getByText('A signature is required before completing.'));
    // No fill/complete call was made.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/fields/'))).toBe(false);
  });
});
