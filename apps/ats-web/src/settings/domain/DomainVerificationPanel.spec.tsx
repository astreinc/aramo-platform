import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DomainVerificationPanel } from './DomainVerificationPanel';
import type { DomainVerificationView } from './domain-api';

// Domain-Enforcement P2b §7 — the domain-verification panel (live request/check).

function view(over: Partial<DomainVerificationView> = {}): DomainVerificationView {
  return {
    status: 'UNVERIFIED',
    allowed_domain: 'acme.corp',
    record_name: '_aramo-challenge.acme.corp',
    record_value: null,
    verified_at: null,
    token_issued_at: null,
    ...over,
  };
}

function pending(): DomainVerificationView {
  return view({
    status: 'PENDING',
    record_value: 'aramo-domain-verification=tok123',
    token_issued_at: '2026-06-26T00:00:00.000Z',
  });
}

function renderPanel(opts: {
  fetchFn?: () => Promise<DomainVerificationView>;
  requestFn?: () => Promise<DomainVerificationView>;
  checkFn?: () => Promise<DomainVerificationView>;
}) {
  return render(
    <ToastProvider>
      <DomainVerificationPanel
        fetchFn={opts.fetchFn}
        requestFn={opts.requestFn}
        checkFn={opts.checkFn}
      />
    </ToastProvider>,
  );
}

describe('DomainVerificationPanel', () => {
  it('UNVERIFIED — shows status + the Start verification button, no record value yet', async () => {
    renderPanel({ fetchFn: () => Promise.resolve(view()) });
    expect(await screen.findByTestId('domain-request')).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
    expect(screen.queryByTestId('domain-record-value')).not.toBeInTheDocument();
  });

  it('Start verification → PENDING reveals the TXT record name + value and the Check button', async () => {
    const requestFn = vi.fn(() => Promise.resolve(pending()));
    renderPanel({ fetchFn: () => Promise.resolve(view()), requestFn });
    fireEvent.click(await screen.findByTestId('domain-request'));
    await waitFor(() => expect(requestFn).toHaveBeenCalledOnce());
    expect(await screen.findByTestId('domain-record-value')).toHaveTextContent(
      'aramo-domain-verification=tok123',
    );
    expect(screen.getByTestId('domain-record-name')).toHaveTextContent(
      '_aramo-challenge.acme.corp',
    );
    expect(screen.getByTestId('domain-check')).toBeInTheDocument();
  });

  it('Check with a match → VERIFIED badge + verified timestamp', async () => {
    const checkFn = vi.fn(() =>
      Promise.resolve(view({ status: 'VERIFIED', verified_at: '2026-06-26T01:00:00.000Z', record_value: 'aramo-domain-verification=tok123' })),
    );
    renderPanel({ fetchFn: () => Promise.resolve(pending()), checkFn });
    fireEvent.click(await screen.findByTestId('domain-check'));
    await waitFor(() => expect(checkFn).toHaveBeenCalledOnce());
    // The status badge + the "Verified / On <date>" row both render "Verified".
    expect((await screen.findAllByText('Verified')).length).toBeGreaterThan(0);
    // The verified timestamp row is shown.
    expect(screen.getByText(/^On /)).toBeInTheDocument();
    // The check + request buttons are gone once VERIFIED (sticky, terminal UI).
    expect(screen.queryByTestId('domain-check')).not.toBeInTheDocument();
  });

  it('Check with no match stays PENDING (no error surfaced)', async () => {
    const checkFn = vi.fn(() => Promise.resolve(pending())); // still PENDING
    renderPanel({ fetchFn: () => Promise.resolve(pending()), checkFn });
    fireEvent.click(await screen.findByTestId('domain-check'));
    await waitFor(() => expect(checkFn).toHaveBeenCalledOnce());
    expect(screen.getByText('Pending DNS')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('no locked domain — shows the status message, no action buttons', async () => {
    renderPanel({
      fetchFn: () =>
        Promise.resolve(view({ allowed_domain: null, record_name: null })),
    });
    await screen.findByText(/No locked domain/i);
    expect(screen.queryByTestId('domain-request')).not.toBeInTheDocument();
    expect(screen.queryByTestId('domain-check')).not.toBeInTheDocument();
  });

  it('copy buttons write the record to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel({ fetchFn: () => Promise.resolve(pending()) });
    fireEvent.click(await screen.findByTestId('domain-copy-value'));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('aramo-domain-verification=tok123'),
    );
  });

  it('shows an error state when the status cannot load', async () => {
    renderPanel({ fetchFn: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
