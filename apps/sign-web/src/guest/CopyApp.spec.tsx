import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyApp } from './CopyApp.js';

vi.mock('./pdf-view.js', () => ({ PdfDocument: () => null }));

// UAT CMP-14 / M-A5 §2.2 — a copy recipient's "For your records" page (/c/:token):
// token only (no session, no sign-in), the documents as sent.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(res: () => Response) {
  const calls: { url: string; init: RequestInit | undefined; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return res();
    }) as unknown as typeof fetch,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, '', '/c/copy-token-1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CopyApp — /c/:token', () => {
  it('shows the documents with View and Download, using only the copy token', async () => {
    const calls = stubFetch(() => json({ subject: 'Offer letter', sent_at: '2026-11-17T10:00:00Z', documents: [{ title: 'Offer.pdf', content_type: 'application/pdf', source_base64: 'JVBERi0x' }] }));
    render(<CopyApp />);
    expect(await screen.findByText('For your records')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Offer letter' })).toBeInTheDocument();
    expect(screen.getByText('Offer.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v1\/sign\/signing\/copy$/);
    expect(calls[0]!.body).toEqual({ token: 'copy-token-1' });
    expect(calls[0]!.init?.credentials).toBe('omit');
  });

  it('an expired link says so; an unknown one is not valid — never a sign-in page', async () => {
    stubFetch(() => json({ error: { code: 'SIGNING_SESSION_EXPIRED', message: 'x' } }, 401));
    render(<CopyApp />);
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    cleanup();
    stubFetch(() => json({ error: { code: 'SIGNING_SESSION_INVALID', message: 'x' } }, 401));
    render(<CopyApp />);
    expect(await screen.findByText("This link isn't valid")).toBeInTheDocument();
  });
});
