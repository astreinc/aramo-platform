import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MicrosoftProviderStatus } from '../microsoft/microsoft-api';

import { CommunicationsProvidersPanel } from './CommunicationsProvidersPanel';
import type { CommunicationProviderConfig } from './provider-config-types';

// COMM PART C — channel-first Communication channels. Proves: least-visibility
// gating; independent channels (Voice/Email/Meeting/SMS); truthful provider states;
// Zoom Meetings shown as a disabled FUTURE option (never selectable); SMS shows
// "No provider available yet"; no secret material.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

const ZOOM_NOT_CONFIGURED: CommunicationProviderConfig = {
  provider_key: 'zoom_phone',
  display_name: 'Zoom Phone',
  connection_id: null,
  configuration_state: 'not_configured',
  status: null,
  credential_configured: false,
  provider_account_id: null,
  last_successful_at: null,
  last_error_code: null,
  recruiter_mapping_count: 0,
  capabilities: { voice: { supported: true, execution: 'available' }, sms: { supported: true, execution: 'not_available' } },
};
const ZOOM_CONFIGURED: CommunicationProviderConfig = {
  ...ZOOM_NOT_CONFIGURED,
  connection_id: 'c1',
  configuration_state: 'configured',
  status: 'configured',
  credential_configured: true,
  recruiter_mapping_count: 2,
};

const MS_NOT_CONFIGURED: MicrosoftProviderStatus = {
  configuration_state: 'NOT_CONFIGURED',
  connection_id: null,
  provider_key: 'microsoft_graph',
  capabilities: { email: true, meeting: true },
  identities: { active: 0, unmapped: 0, disabled: 0, reauth_required: 0 },
};
const MS_CONFIGURED: MicrosoftProviderStatus = { ...MS_NOT_CONFIGURED, configuration_state: 'CONFIGURED', connection_id: 'm1' };

function renderPanel(props: Parameters<typeof CommunicationsProvidersPanel>[0]) {
  return render(
    <ToastProvider>
      <CommunicationsProvidersPanel {...props} />
    </ToastProvider>,
  );
}

const rw = ['integration:read', 'integration:write'];

describe('CommunicationsProvidersPanel — channel-first (PART C)', () => {
  it('renders nothing and makes NO fetch without integration:read', () => {
    const listFn = vi.fn();
    renderPanel({ sessionOverride: makeSession(['communication:read']), listFn });
    expect(screen.queryByTestId('communications-providers')).not.toBeInTheDocument();
    expect(listFn).not.toHaveBeenCalled();
  });

  it('renders the four canonical channels independently', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_NOT_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_NOT_CONFIGURED),
    });
    for (const ch of ['Voice', 'Email', 'Meeting', 'SMS']) {
      expect(await screen.findByTestId(`comm-channel-${ch}`)).toBeInTheDocument();
    }
  });

  it('Voice → Zoom Phone; Email → Microsoft 365; both "Selected · not configured" when unconfigured', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_NOT_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_NOT_CONFIGURED),
    });
    expect(await screen.findByTestId('comm-channel-detail-Voice')).toHaveTextContent(/zoom phone/i);
    expect(screen.getByTestId('comm-channel-state-Voice')).toHaveTextContent(/selected · not configured/i);
    expect(screen.getByTestId('comm-channel-detail-Email')).toHaveTextContent(/microsoft 365/i);
    expect(screen.getByTestId('comm-channel-state-Email')).toHaveTextContent(/selected · not configured/i);
  });

  it('Voice becomes Active + shows mapping count when Zoom is configured', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_NOT_CONFIGURED),
    });
    expect(await screen.findByTestId('comm-channel-state-Voice')).toHaveTextContent(/active/i);
    expect(screen.getByTestId('comm-channel-detail-Voice')).toHaveTextContent(/2 recruiter mappings/i);
  });

  it('Email is Active when Microsoft is configured — independent of Meeting selection', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_NOT_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_CONFIGURED),
    });
    expect(await screen.findByTestId('comm-channel-state-Email')).toHaveTextContent(/active/i);
  });

  it('Meeting → Microsoft Teams ready; Change provider shows Zoom Meetings as a disabled FUTURE option', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_NOT_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_NOT_CONFIGURED),
    });
    fireEvent.click(await screen.findByTestId('comm-change-provider-Meeting'));
    const teams = screen.getByTestId('comm-provider-option-Meeting-MT');
    const zoomMtg = screen.getByTestId('comm-provider-option-Meeting-ZM');
    expect(teams).toHaveTextContent(/microsoft teams/i);
    expect(zoomMtg).toHaveTextContent(/future · not available yet/i);
    expect(zoomMtg.querySelector('input')).toBeDisabled(); // never selectable
  });

  it('SMS → No provider available yet; Choose provider disabled (no dead interaction)', async () => {
    renderPanel({
      sessionOverride: makeSession(rw),
      listFn: vi.fn().mockResolvedValue([ZOOM_NOT_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_NOT_CONFIGURED),
    });
    expect(await screen.findByTestId('comm-channel-state-SMS')).toHaveTextContent(/no provider available yet/i);
    expect(screen.getByTestId('comm-change-provider-SMS')).toBeDisabled();
    expect(screen.queryByTestId('comm-configure-SMS')).toBeNull(); // no Configure for an unbacked channel
  });

  it('read-only actor sees channels but NO Configure/Change controls, no secret material', async () => {
    renderPanel({
      sessionOverride: makeSession(['integration:read']),
      listFn: vi.fn().mockResolvedValue([ZOOM_CONFIGURED]),
      microsoftStatusFn: vi.fn().mockResolvedValue(MS_CONFIGURED),
    });
    await waitFor(() => expect(screen.getByTestId('comm-channel-Voice')).toBeInTheDocument());
    expect(screen.queryByTestId('comm-configure-Voice')).toBeNull();
    expect(screen.queryByTestId('comm-change-provider-Voice')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/secret_ref|access_token|client_secret|arn:aws/i);
  });
});
