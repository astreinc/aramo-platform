import { ApiError, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TalentRecordView } from '../talent/types';

import { CallButton } from './CallButton';
import type { CommunicationCapabilities, CommunicationProviderIdentity } from './types';

// COMM-B4 Boundary D — the scope-gated Call container. Proves least-visibility
// (no communication:voice:call scope → no control AND no communications fetch),
// the capabilities runtime gate (200 → enabled; 409 NOT_CONFIGURED → unavailable
// with no provider-admin detail), and that the enabled button opens CallDrawer.

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}

function makeTalent(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: 'tal-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: '555-0100',
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

const CAPS: CommunicationCapabilities = {
  provider_key: 'zoom_phone',
  capabilities: { voice: { outbound: true, inbound: false, embedded: true } },
};

const IDENTITY: CommunicationProviderIdentity = {
  recruiter_id: 'u1',
  provider_user_id: 'zoom-user-1',
  provider_extension_id: null,
  display_phone_number: '+1 (555) 010-9000',
  extension: null,
  voice_enabled: true,
  sms_enabled: false,
  status: 'active',
};

const CALL_SCOPE = 'communication:voice:call';

describe('CallButton — least-visibility', () => {
  it('renders nothing and makes NO capabilities fetch without the scope', () => {
    const capabilitiesFn = vi.fn();
    render(
      <CallButton
        talent={makeTalent()}
        session={makeSession(['talent:read'])}
        capabilitiesFn={capabilitiesFn}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Call' })).not.toBeInTheDocument();
    expect(capabilitiesFn).not.toHaveBeenCalled();
  });

  it('renders nothing and makes NO fetch for a null session', () => {
    const capabilitiesFn = vi.fn();
    render(<CallButton talent={makeTalent()} session={null} capabilitiesFn={capabilitiesFn} />);
    expect(screen.queryByRole('button', { name: 'Call' })).not.toBeInTheDocument();
    expect(capabilitiesFn).not.toHaveBeenCalled();
  });
});

describe('CallButton — capabilities runtime gate', () => {
  it('enables Call when GET /capabilities resolves 200', async () => {
    const capabilitiesFn = vi.fn().mockResolvedValue(CAPS);
    render(
      <CallButton
        talent={makeTalent()}
        session={makeSession([CALL_SCOPE])}
        capabilitiesFn={capabilitiesFn}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Call' })).toBeEnabled(),
    );
    expect(capabilitiesFn).toHaveBeenCalledTimes(1);
  });

  it('renders Call unavailable on 409 NOT_CONFIGURED with no admin detail', async () => {
    const capabilitiesFn = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, 'not configured', 'COMMUNICATION_PROVIDER_NOT_CONFIGURED'),
      );
    render(
      <CallButton
        talent={makeTalent()}
        session={makeSession([CALL_SCOPE])}
        capabilitiesFn={capabilitiesFn}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled(),
    );
    // No provider-admin detail leaks to the recruiter — nothing naming the
    // provider or configuration state, and no admin control.
    expect(screen.queryByText(/NOT_CONFIGURED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument();
  });
});

describe('CallButton — drawer', () => {
  it('opens CallDrawer when the enabled Call button is clicked', async () => {
    const capabilitiesFn = vi.fn().mockResolvedValue(CAPS);
    const providerIdentityFn = vi.fn().mockResolvedValue(IDENTITY);
    render(
      <CallButton
        talent={makeTalent()}
        session={makeSession([CALL_SCOPE])}
        capabilitiesFn={capabilitiesFn}
        providerIdentityFn={providerIdentityFn}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Call' });
    await waitFor(() => expect(button).toBeEnabled());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(
      screen.getByRole('dialog', { name: /Call Ada Lovelace/i }),
    ).toBeInTheDocument();
  });
});
