import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type TenantDomain, type TenantDomainClaim } from '../platform-api';

import { TenantDomainPanel, domainActions, provisionalCountdown } from './TenantDomainPanel';
import { TenantPeoplePanel } from './TenantPeoplePanel';

// PLATFORM-UX-1 F-5 (handoff §6.3 Domain + People; amendment 4) — the claim
// card, countdown and the four domain actions through the existing endpoints;
// the invite form's role chips (Owner disabled), its error copy, the read-only
// note without :provision, and the designed Members empty card.

const claim = (o: Partial<TenantDomainClaim> = {}): TenantDomainClaim => ({
  domain: 'halvorsenclinics.no',
  claim: 'PROVISIONAL',
  expires_at: '2026-11-01T09:00:00Z',
  reason: 'provisioned',
  exception: false,
  ...o,
});

const DOMAIN = (c: TenantDomainClaim | null, exceptions: TenantDomain['exceptions'] = []): TenantDomain => ({
  tenant_id: 't1',
  domain_claim: c,
  exceptions,
});

const renderDomain = (kind = 'BUSINESS') =>
  render(
    <ToastProvider>
      <TenantDomainPanel tenantId="t1" tenantName="Halvorsen Clinics" kind={kind} />
    </ToastProvider>,
  );

describe('domain rules', () => {
  it('offers the actions the claim allows', () => {
    expect(domainActions(claim())).toEqual(['promote', 'grant', 'release']);
    expect(domainActions(claim({ claim: 'AUTHORITATIVE', exception: true }))).toEqual(['revoke', 'release']);
    expect(domainActions(claim({ claim: 'LAPSED' }))).toEqual(['promote', 'grant', 'release']);
    expect(domainActions(claim({ claim: 'RELEASED' }))).toEqual([]);
  });
  it('counts down the 30-day provisional window', () => {
    expect(provisionalCountdown('2026-11-01T09:00:00Z', new Date('2026-10-24T15:00:00Z'))).toEqual({ daysLeft: 8, pct: 27 });
    expect(provisionalCountdown('2026-10-01T00:00:00Z', new Date('2026-10-24T15:00:00Z'))).toEqual({ daysLeft: 0, pct: 0 });
  });
});

describe('TenantDomainPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the claim card with the countdown', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(claim()));
    renderDomain();
    expect(await screen.findByText('halvorsenclinics.no')).toBeInTheDocument();
    expect(screen.getByText('Provisional', { selector: '.rc-pill' })).toBeInTheDocument();
    expect(screen.getByText('Holds the domain')).toBeInTheDocument();
    expect(screen.getByText('Owner email domain at provisioning')).toBeInTheDocument();
    expect(screen.getByText(/days left of 30/)).toBeInTheDocument();
    expect(screen.getByText('Promote it with evidence before it lapses.')).toBeInTheDocument();
  });

  it('promotes with an evidence reference', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(claim()));
    const promote = vi
      .spyOn(platformApi, 'promoteTenantDomain')
      .mockResolvedValue(DOMAIN(claim({ claim: 'AUTHORITATIVE', expires_at: null, reason: 'operator_evidence' })));
    renderDomain();
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to authoritative…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Promote to authoritative' });
    const commit = within(dialog).getByRole('button', { name: 'Promote claim' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Evidence reference/ }), { target: { value: 'CASE-2291' } });
    fireEvent.click(commit);
    await waitFor(() => expect(promote).toHaveBeenCalledWith('t1', { evidence_ref: 'CASE-2291' }));
    expect(await screen.findByText('halvorsenclinics.no is now authoritative.')).toBeInTheDocument();
    expect(screen.getByText('Authoritative', { selector: '.rc-pill' })).toBeInTheDocument();
  });

  it('releases only with a reason and the acknowledgement', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(claim({ claim: 'AUTHORITATIVE', expires_at: null })));
    const release = vi.spyOn(platformApi, 'releaseTenantDomain').mockResolvedValue(DOMAIN(claim({ claim: 'RELEASED' })));
    renderDomain();
    fireEvent.click(await screen.findByRole('button', { name: 'Release domain…' }));
    const dialog = await screen.findByRole('dialog');
    const commit = within(dialog).getByRole('button', { name: 'Release domain' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Closed' } });
    expect(commit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /another organization could claim/ }));
    fireEvent.click(commit);
    await waitFor(() => expect(release).toHaveBeenCalledWith('t1', { reason: 'Closed' }));
  });

  it('grants and revokes the shared-domain exception', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(claim({ claim: 'AUTHORITATIVE', expires_at: null })));
    const granted = DOMAIN(claim({ claim: 'AUTHORITATIVE', expires_at: null, exception: true }), [
      {
        id: 'x1',
        domain: 'halvorsenclinics.no',
        justification: 'Group agreement',
        evidence_ref: 'CASE-1',
        granted_by_user_id: 'op_7f3a91c2e48b',
        granted_at: '2026-10-24T00:00:00Z',
        revoked_by_user_id: null,
        revoked_at: null,
      },
    ]);
    const grant = vi.spyOn(platformApi, 'grantTenantDomainException').mockResolvedValue(granted);
    const revoke = vi.spyOn(platformApi, 'revokeTenantDomainException').mockResolvedValue(DOMAIN(claim({ claim: 'AUTHORITATIVE' })));
    renderDomain();
    fireEvent.click(await screen.findByRole('button', { name: 'Grant shared-domain exception…' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Justification/ }), { target: { value: 'Group agreement' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Evidence reference/ }), { target: { value: 'CASE-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant exception' }));
    await waitFor(() => expect(grant).toHaveBeenCalledWith('t1', { justification: 'Group agreement', evidence_ref: 'CASE-1' }));
    expect(await screen.findByText('Group agreement')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke exception…' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke exception' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('t1'));
  });

  it('shows the action error in the dialog', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(claim({ claim: 'LAPSED', expires_at: null })));
    vi.spyOn(platformApi, 'promoteTenantDomain').mockRejectedValue(
      new ApiError(409, 'taken', 'TENANT_DOMAIN_UNAVAILABLE', { reason: 'organization_domain_taken' }),
    );
    renderDomain();
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to authoritative…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Evidence reference/ }), { target: { value: 'X' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote claim' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Another organization already holds this domain.');
  });

  it('shows "No domain claim" for a Personal tenant', async () => {
    vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue(DOMAIN(null));
    renderDomain('PERSONAL');
    expect(await screen.findByText('No domain claim')).toBeInTheDocument();
    expect(screen.getByText('Personal tenants don’t claim an email domain.')).toBeInTheDocument();
  });
});

describe('TenantPeoplePanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders role chips with Owner disabled and Tenant admin preselected', () => {
    render(<TenantPeoplePanel tenantId="t1" host="northwind.aramo.ai" canInvite />);
    expect(screen.getByText('They get an email invitation to northwind.aramo.ai.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Owner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Owner' })).toHaveAttribute('title', 'Only an existing owner can grant this.');
    expect(screen.getByRole('button', { name: '✓ Tenant admin' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Recruiter' }));
    expect(screen.getByRole('button', { name: '✓ Recruiter' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Listing a tenant’s existing members isn’t available yet.')).toBeInTheDocument();
  });

  it('validates, then sends the invitation', async () => {
    const invite = vi.spyOn(platformApi, 'inviteTenantUser').mockResolvedValue({
      tenant_id: 't1',
      user_id: 'u',
      membership_id: 'm',
      role_keys: ['tenant_admin'],
      status: 'invitation_sent',
    });
    render(<TenantPeoplePanel tenantId="t1" host="northwind.aramo.ai" canInvite />);
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'Ops@Northwind.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith('t1', { email: 'ops@northwind.com', role_keys: ['tenant_admin'] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent to ops@northwind.com.');
  });

  it.each([
    ['INVITATION_ALREADY_EXISTS', 'This person already has a pending invitation to this tenant.'],
    ['EMAIL_UNAVAILABLE', 'This email belongs to another organization. One person can belong to only one organization.'],
    ['VALIDATION_ERROR', 'Those roles can’t be combined.'],
  ])('maps %s', async (code, copy) => {
    vi.spyOn(platformApi, 'inviteTenantUser').mockRejectedValue(new ApiError(code === 'VALIDATION_ERROR' ? 400 : 409, 'Those roles can’t be combined.', code));
    render(<TenantPeoplePanel tenantId="t1" host="h" canInvite />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).toHaveTextContent(code);
  });

  it('shows the read-only note without :provision, never a silent gap', () => {
    render(<TenantPeoplePanel tenantId="t1" host="h" canInvite={false} />);
    expect(screen.getByRole('note')).toHaveTextContent('You can view this tenant. Inviting users needs the Provision tenants permission.');
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });
});
