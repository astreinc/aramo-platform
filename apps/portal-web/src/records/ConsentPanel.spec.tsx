import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  portalApi,
  type ConsentHistoryResponse,
  type PortalConsentText,
  type TalentConsentState,
} from '../portal-api';

import { ConsentPanel } from './ConsentPanel';

// Portal P2 P2b (§PR-2) — the consent management panel. portalApi rides
// apiClient → fetch; we stub each method directly (P1 convention). Covers:
// honest per-scope state, the grant flow rendering the EXACT versioned text with
// the recipient named in chrome (+ Idempotency-Key UUID), the revoke flow with
// immediate reflection, and the append-only history list.

const RECORD_ID = 'a1a1a1a1-a1a1-7a1a-8a1a-a1a1a1a1a1a1';

const STATE: TalentConsentState = {
  talent_record_id: RECORD_ID,
  tenant_id: '11111111-1111-7111-8111-111111111111',
  is_anonymized: false,
  computed_at: '2026-07-15T00:00:00.000Z',
  scopes: [
    {
      scope: 'matching',
      status: 'granted',
      granted_at: '2026-07-01T00:00:00.000Z',
      revoked_at: null,
      expires_at: '2027-07-01T00:00:00.000Z',
    },
    {
      scope: 'contacting',
      status: 'expired',
      granted_at: '2025-01-01T00:00:00.000Z',
      revoked_at: null,
      expires_at: '2026-01-01T00:00:00.000Z',
    },
    {
      scope: 'profile_storage',
      status: 'no_grant',
      granted_at: null,
      revoked_at: null,
      expires_at: null,
    },
    {
      scope: 'resume_processing',
      status: 'revoked',
      granted_at: '2026-02-01T00:00:00.000Z',
      revoked_at: '2026-03-01T00:00:00.000Z',
      expires_at: null,
    },
    {
      scope: 'cross_tenant_visibility',
      status: 'no_grant',
      granted_at: null,
      revoked_at: null,
      expires_at: null,
    },
  ],
};

const TEXT: PortalConsentText = {
  version: 'portal-consent-v1',
  texts: [
    { scope: 'matching', text: 'I authorize matching text.' },
    { scope: 'contacting', text: 'I authorize contacting text.' },
    { scope: 'profile_storage', text: 'I authorize profile storage text.' },
    { scope: 'resume_processing', text: 'I authorize résumé processing text.' },
    {
      scope: 'cross_tenant_visibility',
      text: 'I authorize cross-tenant visibility text.',
    },
  ],
};

const HISTORY: ConsentHistoryResponse = {
  events: [
    {
      event_id: 'e1',
      scope: 'matching',
      action: 'granted',
      created_at: '2026-07-01T00:00:00.000Z',
      expires_at: '2027-07-01T00:00:00.000Z',
    },
    {
      event_id: 'e2',
      scope: 'resume_processing',
      action: 'revoked',
      created_at: '2026-03-01T00:00:00.000Z',
      expires_at: null,
    },
  ],
  next_cursor: null,
  is_anonymized: false,
};

function stubReads() {
  vi.spyOn(portalApi, 'getRecordConsent').mockResolvedValue(STATE);
  vi.spyOn(portalApi, 'getConsentHistory').mockResolvedValue(HISTORY);
  vi.spyOn(portalApi, 'getConsentText').mockResolvedValue(TEXT);
}

describe('ConsentPanel', () => {
  beforeEach(() => {
    // crypto.randomUUID exists in jsdom 22+, but pin it for a stable assertion.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders honest per-scope state (active/expired/revoked/not granted)', async () => {
    stubReads();
    render(<ConsentPanel recordId={RECORD_ID} tenantName="Acme Corp" />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getAllByText('Not granted').length).toBe(2);
    // Recipient named in chrome.
    expect(
      screen.getByText(/What Acme Corp may do with your information/),
    ).toBeInTheDocument();
  });

  it('renders the append-only history list', async () => {
    stubReads();
    render(<ConsentPanel recordId={RECORD_ID} tenantName="Acme Corp" />);

    const history = await screen.findByRole('list');
    expect(within(history).getByText('granted')).toBeInTheDocument();
    expect(within(history).getByText('revoked')).toBeInTheDocument();
  });

  it('grant flow shows the EXACT versioned text + submits version and a UUID key', async () => {
    stubReads();
    const grant = vi
      .spyOn(portalApi, 'grantConsent')
      .mockResolvedValue({
        scope: 'contacting',
        action: 'granted',
        occurred_at: '2026-07-15T00:00:00.000Z',
        expires_at: '2027-07-15T00:00:00.000Z',
      });
    render(<ConsentPanel recordId={RECORD_ID} tenantName="Acme Corp" />);

    // The first non-granted scope offering a Grant is `contacting` (expired) —
    // regranting it is the renewal path.
    await screen.findByText('Active');
    const grantButtons = screen.getAllByRole('button', { name: 'Grant' });
    fireEvent.click(grantButtons[0]);

    // The dialog renders the exact backend text (the D7 preimage) + names the
    // recipient in the title.
    expect(
      await screen.findByText('I authorize contacting text.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Grant consent to Acme Corp'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'I agree' }));

    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    expect(grant).toHaveBeenCalledWith(
      RECORD_ID,
      'contacting',
      'portal-consent-v1',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });

  it('revoke flow confirms then reflects new state (refetch)', async () => {
    stubReads();
    const revoke = vi
      .spyOn(portalApi, 'revokeConsent')
      .mockResolvedValue({
        scope: 'matching',
        action: 'revoked',
        occurred_at: '2026-07-15T00:00:00.000Z',
        expires_at: null,
      });
    render(<ConsentPanel recordId={RECORD_ID} tenantName="Acme Corp" />);

    await screen.findByText('Active');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    // Confirm dialog, then the affirmative Revoke.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke).toHaveBeenCalledWith(
      RECORD_ID,
      'matching',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    // Immediate reflection: state re-read (getRecordConsent called twice — mount
    // + post-revoke refetch).
    expect(portalApi.getRecordConsent).toHaveBeenCalledTimes(2);
  });
});
