import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IntegrationConnectionsPanel } from './IntegrationConnectionsPanel';
import type { IntegrationConnectionView } from './types';

// T8-CONNECTOR-A — connector-management panel: least-visibility gating + no
// secret render (directive §38). T10-B2/F-021 — mutation UX coherence.

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't1',
    scopes,
    iat: 0,
    exp: 0,
  };
}

const CONN: IntegrationConnectionView = {
  id: 'c1',
  tenant_id: 't1',
  provider_key: 'acme_vms',
  status: 'configured',
  has_secret: true,
  provider_account_id: null,
  last_attempted_at: null,
  last_successful_at: null,
  last_error_code: null,
  last_error_summary: null,
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
};

// The panel now uses useToast() → every render must sit under a ToastProvider
// (production wraps the whole app in one). renderPanel supplies it.
function renderPanel(props: Parameters<typeof IntegrationConnectionsPanel>[0]) {
  return render(
    <ToastProvider>
      <IntegrationConnectionsPanel {...props} />
    </ToastProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('IntegrationConnectionsPanel — least-visibility', () => {
  it('renders nothing and makes NO fetch without integration:read', () => {
    const listFn = vi.fn();
    renderPanel({
      sessionOverride: makeSession(['requisition:import:read']),
      listFn,
    });
    // The panel surface is absent (only the ToastProvider viewport exists) and
    // no read fires — least-visibility preserved.
    expect(screen.queryByTestId('integration-connections')).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(listFn).not.toHaveBeenCalled();
  });

  it('read-only actor sees connections + status but NO write controls, and no secret material', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    renderPanel({ sessionOverride: makeSession(['integration:read']), listFn });
    await waitFor(() =>
      expect(screen.getByTestId('integration-connection-c1')).toBeInTheDocument(),
    );
    expect(screen.getByText('acme_vms')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Credential configured')).toBeInTheDocument();
    expect(screen.queryByTestId('integration-enable-c1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-disable-c1')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(
      /secret_ref|aramo\/[a-z]+\/connector|connector:v1/,
    );
  });

  it('write actor sees enable/disable affordances', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    renderPanel({
      sessionOverride: makeSession(['integration:read', 'integration:write']),
      listFn,
    });
    await waitFor(() =>
      expect(screen.getByTestId('integration-connection-c1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('integration-enable-c1')).toBeInTheDocument();
    expect(screen.getByTestId('integration-disable-c1')).toBeInTheDocument();
  });

  it('shows the shared empty state when there are no connections', async () => {
    const listFn = vi.fn().mockResolvedValue([]);
    renderPanel({ sessionOverride: makeSession(['integration:read']), listFn });
    expect(
      await screen.findByText('No connector connections have been configured yet.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('surfaces a safe retryable error when the list read fails (no raw exception)', async () => {
    const listFn = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.4:5432 prisma pool'));
    renderPanel({ sessionOverride: makeSession(['integration:read']), listFn });
    await waitFor(() =>
      expect(screen.getByTestId('error-state')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load connector connections.',
    );
    expect(screen.getByTestId('error-retry')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('ECONNREFUSED');
    expect(document.body.innerHTML).not.toContain('prisma');
  });
});

describe('IntegrationConnectionsPanel — mutation coherence (T10-B2/F-021)', () => {
  const WRITER = makeSession(['integration:read', 'integration:write']);

  it('enable: busy state + duplicate-submit block, success toast, and server re-read', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    const d = deferred<IntegrationConnectionView>();
    const enableFn = vi.fn().mockReturnValue(d.promise);
    renderPanel({ sessionOverride: WRITER, listFn, enableFn });
    const btn = await screen.findByTestId('integration-enable-c1');

    fireEvent.click(btn);
    // In-flight: this control disables + shows a busy label (no duplicate fire).
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent('Working…');
    fireEvent.click(btn); // blocked (disabled)
    expect(enableFn).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledTimes(1); // not re-read yet

    d.resolve({ ...CONN, status: 'active' });
    // Success toast + authoritative re-read.
    expect(await screen.findByText('Connector connection enabled.')).toBeInTheDocument();
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2));
  });

  it('enable: a failed mutation surfaces SAFE copy, never the raw exception', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    const enableFn = vi
      .fn()
      .mockRejectedValue(new Error('Prisma P2002 unique constraint db-internal-7'));
    renderPanel({ sessionOverride: WRITER, listFn, enableFn });
    const btn = await screen.findByTestId('integration-enable-c1');
    fireEvent.click(btn);
    expect(
      await screen.findByText('Could not enable the connection. Try again.'),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('Prisma');
    expect(document.body.innerHTML).not.toContain('db-internal-7');
  });

  it('disable: requires shared-Dialog confirmation; cancel does NOT mutate', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    const disableFn = vi.fn().mockResolvedValue({ ...CONN, status: 'disabled' });
    renderPanel({ sessionOverride: WRITER, listFn, disableFn });
    const btn = await screen.findByTestId('integration-disable-c1');

    fireEvent.click(btn);
    // Confirmation dialog appears; no mutation yet.
    expect(await screen.findByText('Disable this connection?')).toBeInTheDocument();
    expect(disableFn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('integration-disable-cancel'));
    await waitFor(() =>
      expect(screen.queryByText('Disable this connection?')).not.toBeInTheDocument(),
    );
    expect(disableFn).not.toHaveBeenCalled();
  });

  it('disable: confirming mutates once, shows success, and re-reads', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    const disableFn = vi.fn().mockResolvedValue({ ...CONN, status: 'disabled' });
    renderPanel({ sessionOverride: WRITER, listFn, disableFn });
    fireEvent.click(await screen.findByTestId('integration-disable-c1'));
    fireEvent.click(await screen.findByTestId('integration-disable-confirm'));
    expect(
      await screen.findByText('Connector connection disabled.'),
    ).toBeInTheDocument();
    expect(disableFn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2));
  });
});
