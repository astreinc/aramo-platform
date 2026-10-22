import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import { REPORT_REASONS, reportTokenFromHash } from './ReportPage';

// Aramo Sign Personal §6.4 — "Report this email": no sign-in, token from the URL
// fragment (dropped from the address bar), an optional reason, an optional note.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const TOKEN = 'r'.repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function open(fetch: ReturnType<typeof vi.fn>, hash = `#token=${TOKEN}`) {
  window.history.replaceState(null, '', `/report${hash}`);
  vi.stubGlobal('fetch', fetch);
  return render(
    <MemoryRouter initialEntries={['/report']}>
      <App />
    </MemoryRouter>,
  );
}

const reportFetch = (status: number) =>
  vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/report') ? json({ received: true }, status) : json({}, 401)));

describe('/report', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('reads the token from the fragment, drops it, and posts the reason and note', async () => {
    const fetch = reportFetch(202);
    open(fetch);
    expect(await screen.findByTestId('report-form')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(screen.getAllByRole('radio')).toHaveLength(REPORT_REASONS.length);
    fireEvent.click(screen.getByLabelText('It looks like phishing or a scam'));
    fireEvent.change(screen.getByLabelText('Anything else? (optional)'), { target: { value: ' Asked for my bank login ' } });
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(await screen.findByTestId('report-thanks')).toHaveTextContent('Your report was sent.');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/v1/sign/report'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ token: TOKEN, reason: 'phishing', note: 'Asked for my bank login' });
    expect((call[1] as RequestInit).credentials).toBeUndefined();
  });

  it('the reason is optional (Acceptable Use Policy §8.1): a report without one sends the token only; the policy is linked', async () => {
    const fetch = reportFetch(202);
    open(fetch);
    expect(await screen.findByRole('link', { name: 'Acceptable Use Policy' })).toHaveAttribute('href', '/legal/acceptable-use/1.0');
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(await screen.findByTestId('report-thanks')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acceptable Use Policy' })).toHaveAttribute('target', '_blank');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/v1/sign/report'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ token: TOKEN });
  });

  it('a second report for the same email is acknowledged (409)', async () => {
    open(reportFetch(409));
    fireEvent.click(await screen.findByLabelText('I don’t know the sender'));
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(await screen.findByTestId('report-thanks')).toHaveTextContent('We already have your report');
  });

  it('an invalid token or a missing one shows the link-can’t-be-used page', async () => {
    const first = open(reportFetch(404));
    fireEvent.click(await screen.findByLabelText('It’s unwanted or spam'));
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(await screen.findByTestId('report-invalid')).toBeInTheDocument();
    first.unmount();
    open(reportFetch(202), '');
    expect(await screen.findByTestId('report-invalid')).toBeInTheDocument();
  });

  it('rate limiting keeps the form with a message', async () => {
    open(reportFetch(429));
    fireEvent.click(await screen.findByLabelText('Something else'));
    fireEvent.click(screen.getByTestId('report-submit'));
    expect(await screen.findByText('Too many reports from this connection. Try again later.')).toBeInTheDocument();
    expect(screen.getByTestId('report-form')).toBeInTheDocument();
  });

  it('reportTokenFromHash ignores short tokens', () => {
    expect(reportTokenFromHash('#token=abc')).toBeNull();
    expect(reportTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
  });
});
