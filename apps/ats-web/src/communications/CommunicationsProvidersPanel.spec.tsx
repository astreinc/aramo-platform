import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CommunicationsProvidersPanel } from './CommunicationsProvidersPanel';
import type { CommunicationProviderConfig } from './provider-config-types';

// COMM-C1 — Settings → Integrations → Communications panel. Proves: least-
// visibility gating (integration:read/write); truthful capability posture (voice
// available, SMS declared / execution deferred — never a Send affordance); no
// secret material; and that ONLY the ratified provider is surfaced (no
// non-ratified / excluded-vendor control appears).

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const CONFIGURED: CommunicationProviderConfig = {
  provider_key: 'zoom_phone',
  display_name: 'Zoom Phone',
  connection_id: 'c1',
  configuration_state: 'configured',
  status: 'configured',
  credential_configured: true,
  provider_account_id: 'zoom-acct-1',
  last_successful_at: null,
  last_error_code: null,
  recruiter_mapping_count: 2,
  capabilities: {
    voice: { supported: true, execution: 'available' },
    sms: { supported: true, execution: 'not_available' },
  },
};

const NOT_CONFIGURED: CommunicationProviderConfig = {
  ...CONFIGURED,
  connection_id: null,
  configuration_state: 'not_configured',
  status: null,
  credential_configured: false,
  recruiter_mapping_count: 0,
};

function renderPanel(props: Parameters<typeof CommunicationsProvidersPanel>[0]) {
  return render(
    <ToastProvider>
      <CommunicationsProvidersPanel {...props} />
    </ToastProvider>,
  );
}

describe('CommunicationsProvidersPanel — least-visibility', () => {
  it('renders nothing and makes NO fetch without integration:read', () => {
    const listFn = vi.fn();
    renderPanel({ sessionOverride: makeSession(['communication:read']), listFn });
    expect(screen.queryByTestId('communications-providers')).not.toBeInTheDocument();
    expect(listFn).not.toHaveBeenCalled();
  });

  it('read-only actor sees the provider + capabilities but NO write controls, no secret', async () => {
    const listFn = vi.fn().mockResolvedValue([CONFIGURED]);
    renderPanel({ sessionOverride: makeSession(['integration:read']), listFn });
    await waitFor(() =>
      expect(screen.getByTestId('comm-provider-zoom_phone')).toBeInTheDocument(),
    );
    expect(screen.getByText('Zoom Phone')).toBeInTheDocument();
    // Truthful capability posture.
    const caps = screen.getByTestId('comm-caps-zoom_phone');
    expect(caps).toHaveTextContent('Voice — Available');
    expect(caps).toHaveTextContent('SMS — Declared / execution deferred');
    // No write affordances for a read-only actor.
    expect(screen.queryByTestId('comm-configure-zoom_phone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comm-test-zoom_phone')).not.toBeInTheDocument();
    // No secret material, and never a Send-SMS affordance.
    expect(document.body.innerHTML).not.toMatch(/secret_ref|access_token|connector:v1|arn:aws/i);
    expect(document.body.innerHTML).not.toMatch(/send sms/i);
  });

  it('write actor sees configure/test/mappings/disable controls', async () => {
    const listFn = vi.fn().mockResolvedValue([CONFIGURED]);
    renderPanel({
      sessionOverride: makeSession(['integration:read', 'integration:write']),
      listFn,
    });
    await waitFor(() =>
      expect(screen.getByTestId('comm-configure-zoom_phone')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('comm-test-zoom_phone')).toBeEnabled();
    expect(screen.getByTestId('comm-mappings-zoom_phone')).toBeEnabled();
    expect(screen.getByTestId('comm-disable-zoom_phone')).toBeInTheDocument();
  });

  it('not-configured provider renders truthfully: Configure enabled, Test disabled', async () => {
    const listFn = vi.fn().mockResolvedValue([NOT_CONFIGURED]);
    renderPanel({
      sessionOverride: makeSession(['integration:read', 'integration:write']),
      listFn,
    });
    await waitFor(() =>
      expect(screen.getByTestId('comm-provider-zoom_phone')).toBeInTheDocument(),
    );
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByTestId('comm-configure-zoom_phone')).toBeEnabled();
    // Test/mappings are meaningless until configured → disabled.
    expect(screen.getByTestId('comm-test-zoom_phone')).toBeDisabled();
    expect(screen.getByTestId('comm-mappings-zoom_phone')).toBeDisabled();
  });

  it('surfaces ONLY the ratified provider — no excluded-vendor control', async () => {
    const listFn = vi.fn().mockResolvedValue([CONFIGURED]);
    renderPanel({
      sessionOverride: makeSession(['integration:read', 'integration:write']),
      listFn,
    });
    await waitFor(() =>
      expect(screen.getByTestId('comm-provider-zoom_phone')).toBeInTheDocument(),
    );
    // Exactly one provider card is rendered, and it is the ratified Zoom provider.
    // (Backend only surfaces zoom_phone; no excluded-vendor row can appear.)
    const cards = document.querySelectorAll('[data-testid^="comm-provider-"]');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-testid')).toBe('comm-provider-zoom_phone');
  });
});
