import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { AccountStatus, SenderContext } from '../api';

import { UpgradeToBusinessSection, type UpgradeStatus } from './AccountUpgrade';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — Settings → Upgrade to
// Business: hidden while the backend has it switched off (404) or the account may not
// upgrade; shown to an eligible Personal owner with the consequences; organization
// details, attestation and terms are required; typing UPGRADE confirms.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const SESSION = { sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes: ['sign:envelope:read'], iat: 0, exp: 9_999_999_999 };
const PERSONAL: SenderContext = {
  user: { id: 'u1', email: 'pat@gmail.com', display_name: 'Pat Lee' },
  tenant: { id: 't1', name: 'Pat Lee', kind: 'PERSONAL' },
  workspace: 'personal',
  permissions: { read: true, create: true, send: true },
  can_send: true,
  personal_sending_enabled: true,
  organization_url: null,
  app_home_url: null,
};
const OPEN: AccountStatus = { closable: true, closed: false, closed_at: null };
const ELIGIBLE: UpgradeStatus = {
  eligible: true,
  reason: null,
  current_name: 'Pat Lee (Personal 1a2b3c4d)',
  terms: { key: 'sign.terms_of_service', version: '2.0', url: 'https://sign.aramo.ai/legal/terms/2.0' },
  subscription: { plan_key: 'aramo-sign-free-personal-v1', source: 'FREE' },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(upgrade: Response | (() => Response)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/sign/session')) return json(SESSION);
    if (url.endsWith('/v1/sign/sender/context')) return json(PERSONAL);
    if (url.endsWith('/v1/sign/account/status')) return json(OPEN);
    if (url.endsWith('/v1/sign/account/upgrade')) return typeof upgrade === 'function' ? upgrade() : upgrade;
    if (url.endsWith('/v1/sign/legal/status')) return json({ pending: [] });
    if (url.endsWith('/v1/sign/sender/summary')) return json({ counts: {}, awaiting_signatures: 0, months: [], expiring_soon: [] });
    return json({ items: [], counts: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderSettings = () =>
  render(
    <MemoryRouter initialEntries={['/personal/settings/personal']}>
      <App />
    </MemoryRouter>,
  );

function fill() {
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Pat Lee Consulting' } });
  const text: Record<string, string> = {
    'Legal name': 'Pat Lee Consulting LLC',
    'Street address': '1 Main St',
    City: 'Vienna',
    'ZIP code': '22181',
    'Billing contact email': 'billing@patlee.example',
    'Your full name': 'Pat Lee',
    'Your title': 'Owner',
  };
  for (const [label, value] of Object.entries(text)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'VA' } });
}

describe('Upgrade to Business (Personal)', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('is hidden while the backend has the upgrade switched off (404)', async () => {
    stub(json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
    renderSettings();
    await screen.findByTestId('settings-close-account');
    expect(screen.queryByTestId('settings-upgrade-business')).toBeNull();
  });

  it('is shown to an eligible Personal owner in Settings with the consequences and the terms link', async () => {
    stub(json(ELIGIBLE));
    renderSettings();
    const card = await screen.findByTestId('settings-upgrade-business');
    expect(card).toHaveTextContent('stay exactly as they are');
    expect(card).toHaveTextContent('Free personal plan ends');
    expect(card).toHaveTextContent('can’t be undone');
    expect(screen.getByRole('link', { name: 'Aramo Sign Terms of Service' })).toHaveAttribute('href', ELIGIBLE.terms!.url);
    expect(screen.getByRole('button', { name: 'Upgrade to Business' })).toBeDisabled();
  });

  it('hides the card for a refusal the owner cannot act on and explains the ones they can', async () => {
    const terms = render(<UpgradeToBusinessSection loader={async () => ({ ...ELIGIBLE, eligible: false, reason: 'business_terms_not_available', terms: null })} />);
    await waitFor(() => expect(screen.queryByTestId('settings-upgrade-business')).toBeNull());
    terms.unmount();
    render(<UpgradeToBusinessSection loader={async () => ({ ...ELIGIBLE, eligible: false, reason: 'personal_paid_subscription_upgrade_unsupported' })} />);
    expect(await screen.findByTestId('upgrade-unavailable')).toHaveTextContent('paid Personal plan');
  });

  it('requires the organization details and the attestation before it submits, then sends the upgrade and moves on', async () => {
    const upgrader = vi.fn(async () => ({ state: 'upgraded' }));
    const onUpgraded = vi.fn();
    render(<UpgradeToBusinessSection loader={async () => ELIGIBLE} upgrader={upgrader} onUpgraded={onUpgraded} />);
    const button = await screen.findByRole('button', { name: 'Upgrade to Business' });
    fireEvent.click(screen.getByLabelText('I accept the business terms'));
    fireEvent.change(screen.getByLabelText('Type UPGRADE to confirm'), { target: { value: 'UPGRADE' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText('Enter an organization name (2–100 characters).')).toBeInTheDocument();
    expect(upgrader).not.toHaveBeenCalled();
    fill();
    fireEvent.click(button);
    expect(await screen.findByText('Confirm that you are authorized to act for this organization.')).toBeInTheDocument();
    expect(upgrader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('I am authorized to act for this organization'));
    fireEvent.click(button);
    await waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1));
    expect(upgrader).toHaveBeenCalledWith({
      confirm: 'UPGRADE',
      organization_name: 'Pat Lee Consulting',
      accept_terms: true,
      organization: expect.objectContaining({ legal_name: 'Pat Lee Consulting LLC', state_province: 'VA', country_code: 'US', authority_attested: true }),
    });
  });

  it('a refused upgrade shows the reason and stays put', async () => {
    const onUpgraded = vi.fn();
    const upgrader = vi.fn(async () => {
      throw new ApiError(409, 'An organization with this name already exists on Aramo. Choose another name.', 'TENANT_ALREADY_EXISTS', { reason: 'organization_name_taken' });
    });
    render(<UpgradeToBusinessSection loader={async () => ELIGIBLE} upgrader={upgrader} onUpgraded={onUpgraded} />);
    await screen.findByRole('button', { name: 'Upgrade to Business' });
    fill();
    fireEvent.click(screen.getByLabelText('I am authorized to act for this organization'));
    fireEvent.click(screen.getByLabelText('I accept the business terms'));
    fireEvent.change(screen.getByLabelText('Type UPGRADE to confirm'), { target: { value: 'UPGRADE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Business' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(onUpgraded).not.toHaveBeenCalled();
  });
});
