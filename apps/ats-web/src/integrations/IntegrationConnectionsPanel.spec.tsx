import { type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IntegrationConnectionsPanel } from './IntegrationConnectionsPanel';
import type { IntegrationConnectionView } from './types';

// T8-CONNECTOR-A — connector-management panel: least-visibility gating + no
// secret render (directive §38, Architect UI rails).

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

describe('IntegrationConnectionsPanel — least-visibility', () => {
  it('renders nothing and makes NO fetch without integration:read', () => {
    const listFn = vi.fn();
    const { container } = render(
      <IntegrationConnectionsPanel sessionOverride={makeSession(['requisition:import:read'])} listFn={listFn} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(listFn).not.toHaveBeenCalled();
  });

  it('read-only actor sees connections + status but NO write controls, and no secret material', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    render(
      <IntegrationConnectionsPanel sessionOverride={makeSession(['integration:read'])} listFn={listFn} />,
    );
    await waitFor(() => expect(screen.getByTestId('integration-connection-c1')).toBeInTheDocument());
    expect(screen.getByText('acme_vms')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Credential configured')).toBeInTheDocument(); // presence only
    // No write affordances for a read-only actor.
    expect(screen.queryByTestId('integration-enable-c1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-disable-c1')).not.toBeInTheDocument();
    // No secret material anywhere in the rendered DOM.
    expect(document.body.innerHTML).not.toMatch(/secret_ref|aramo\/[a-z]+\/connector|connector:v1/);
  });

  it('write actor sees enable/disable affordances', async () => {
    const listFn = vi.fn().mockResolvedValue([CONN]);
    render(
      <IntegrationConnectionsPanel
        sessionOverride={makeSession(['integration:read', 'integration:write'])}
        listFn={listFn}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('integration-connection-c1')).toBeInTheDocument());
    // configured (not active/disabled) → both enable + disable available to a writer
    expect(screen.getByTestId('integration-enable-c1')).toBeInTheDocument();
    expect(screen.getByTestId('integration-disable-c1')).toBeInTheDocument();
  });

  it('shows an empty state when there are no connections', async () => {
    const listFn = vi.fn().mockResolvedValue([]);
    render(
      <IntegrationConnectionsPanel sessionOverride={makeSession(['integration:read'])} listFn={listFn} />,
    );
    expect(await screen.findByTestId('integration-empty')).toBeInTheDocument();
  });
});
