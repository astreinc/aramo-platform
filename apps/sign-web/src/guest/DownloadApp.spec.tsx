import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DownloadApp } from './DownloadApp.js';

vi.mock('./pdf-view.js', () => ({ PdfDocument: () => null }));

// Aramo Sign launch — the signer's signed-copy page (sign.aramo.ai/d/:token).
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(res: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return res();
    }) as unknown as typeof fetch,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, '', '/d/dl-token-1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DownloadApp', () => {
  it('shows the signed document and certificate for a valid link, sending only the token', async () => {
    const calls = stubFetch(() =>
      json({
        subject: 'Master Services Agreement',
        completed_at: '2026-10-18T12:00:00.000Z',
        documents: [{ title: 'msa.pdf', content_type: 'application/pdf', executed_base64: btoa('%PDF-1.4') }],
        certificate_base64: btoa('%PDF-1.4 cert'),
      }),
    );
    render(<DownloadApp />);
    expect(await screen.findByRole('heading', { name: 'Master Services Agreement' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download msa.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download certificate of completion' })).toBeTruthy();
    expect(calls[0]!.url).toBe('/v1/sign/signing/executed');
    expect(calls[0]!.body).toEqual({ token: 'dl-token-1' });
  });

  it('explains an expired link', async () => {
    stubFetch(() => json({ error: { code: 'SIGNING_SESSION_EXPIRED' } }, 401));
    render(<DownloadApp />);
    expect(await screen.findByText('This download link has expired')).toBeTruthy();
  });

  it('explains an invalid link', async () => {
    stubFetch(() => json({ error: { code: 'SIGNING_SESSION_INVALID' } }, 401));
    render(<DownloadApp />);
    expect(await screen.findByText("This download link isn't valid")).toBeTruthy();
  });
});
