import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  platformApi,
  type PlatformAuditEvent,
  type PlatformTenantDetail,
  type PlatformTenantSign,
} from '../platform-api';

import { TenantDetailView, resolveTab, visibleTabs } from './TenantDetailView';
import { submitLifecycle } from './LifecycleDialog';
import { EMPTY_LIFECYCLE_VALUES } from './lifecycle-reasons';
import { ALL_TENANT_SCOPES, READ_ONLY_TENANT, renderAt, tenantSession } from './test-utils';

// PLATFORM-UX-1 F-5 (handoff §6.3, §7; amendment 13) — header (kind badge,
// host, ID + Copy), the lifecycle menu limited to the allowed transitions, the
// view-only note, `?tab=` with Domain hidden without lifecycle:manage, the
// Overview invite callout, the timeline, and the lifecycle dialogs (from → to,
// consequence, fields, illegal_transition, already-in-status, success toast +
// timeline refetch).

const TENANT = (o: Partial<PlatformTenantDetail> = {}): PlatformTenantDetail => ({
  id: 'tn_01J8Q2NWX4',
  name: 'Northwind Logistics',
  kind: 'BUSINESS',
  is_active: true,
  created_at: '2026-03-02T10:12:00Z',
  updated_at: '2026-03-04T08:40:00Z',
  identity_provider: 'microsoft',
  status: 'ACTIVE',
  slug: 'northwind',
  ...o,
});

const EVENTS: PlatformAuditEvent[] = [
  {
    event_type: 'tenant.activated',
    created_at: '2026-03-04T08:40:02Z',
    actor_type: 'system',
    actor_id: null,
    event_payload: { before: { status: 'PROVISIONED' }, after: { status: 'ACTIVE' }, reason: { code: null, text: null }, context: { source: 'owner_first_session' } },
  },
  {
    event_type: 'tenant.provisioned',
    created_at: '2026-03-02T10:12:00Z',
    actor_type: 'user',
    actor_id: 'op_7f3a91c2e48b',
    event_payload: {},
  },
];

const SIGN: PlatformTenantSign = {
  tenant_id: 'tn_01J8Q2NWX4',
  tenant_kind: 'BUSINESS',
  capabilities: ['core', 'ats', 'portal', 'sign'],
  sign_entitled: true,
  subscription: null,
  allowance: { subscribed: false, state: 'NONE' },
  storage: null,
  billing_available: false,
  billing_events: [],
};

let getTenant: ReturnType<typeof vi.fn>;
let getAudit: ReturnType<typeof vi.fn>;

function mockApi(t: PlatformTenantDetail, events = EVENTS): void {
  getTenant = vi.fn().mockResolvedValue({ tenant: t });
  getAudit = vi.fn().mockResolvedValue({ events });
  vi.spyOn(platformApi, 'getTenant').mockImplementation(getTenant);
  vi.spyOn(platformApi, 'getTenantAudit').mockImplementation(getAudit);
  vi.spyOn(platformApi, 'getTenantSign').mockResolvedValue(SIGN);
  vi.spyOn(platformApi, 'getTenantDomain').mockResolvedValue({ tenant_id: t.id, domain_claim: null, exceptions: [] });
}

const renderDetail = (url = '/tenants/tn_01J8Q2NWX4', scopes = ALL_TENANT_SCOPES) =>
  renderAt(<TenantDetailView session={tenantSession(scopes)} />, { path: '/tenants/:id', url, session: tenantSession(scopes) });

describe('tab rules', () => {
  it('hides Domain without lifecycle:manage', () => {
    expect(visibleTabs(true)).toEqual(['overview', 'lifecycle', 'sign', 'domain', 'people']);
    expect(visibleTabs(false)).toEqual(['overview', 'lifecycle', 'sign', 'people']);
  });
  it('falls back to Overview for an unknown or hidden tab', () => {
    expect(resolveTab('lifecycle', visibleTabs(true))).toBe('lifecycle');
    expect(resolveTab('domain', visibleTabs(false))).toBe('overview');
    expect(resolveTab(null, visibleTabs(true))).toBe('overview');
  });
});

describe('submitLifecycle', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sends the per-action body', async () => {
    const res = { tenant_id: 't', from: 'ACTIVE', to: 'OFFBOARDING', status: 'OFFBOARDING', changed: true };
    const off = vi.spyOn(platformApi, 'startOffboarding').mockResolvedValue(res);
    await submitLifecycle('offboard', 't', { ...EMPTY_LIFECYCLE_VALUES, retention: 'standard_90d', closeAt: '2026-12-01', text: ' note ' });
    expect(off).toHaveBeenCalledWith('t', { retentionPolicyCode: 'standard_90d', closeAt: '2026-12-01T00:00:00.000Z', reasonText: 'note' });
    const close = vi.spyOn(platformApi, 'close').mockResolvedValue({ ...res, to: 'CLOSED' });
    await submitLifecycle('close', 't', { ...EMPTY_LIFECYCLE_VALUES, code: 'duplicate_tenant', ack: true });
    expect(close).toHaveBeenCalledWith('t', { reasonCode: 'duplicate_tenant' });
  });
});

describe('TenantDetailView', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the header with kind badge, host and ID + Copy', async () => {
    mockApi(TENANT());
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Northwind Logistics' })).toBeInTheDocument();
    expect(screen.getByText('Business', { selector: '.pt-kind' })).toBeInTheDocument();
    expect(screen.getByText('northwind.aramo.ai')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy tenant ID' }));
    expect(await screen.findByText('Tenant ID copied.')).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('tn_01J8Q2NWX4');
  });

  it('lists only the allowed transitions in the lifecycle menu', async () => {
    mockApi(TENANT({ status: 'ACTIVE' }));
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /Lifecycle actions/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'SuspendBlock sign-in and freeze writes. Reversible.',
      'Start offboardingBegin a wind-down toward closing.',
    ]);
  });

  it('adds the Provisioned note and offers only Close', async () => {
    mockApi(TENANT({ status: 'PROVISIONED', is_active: false }), []);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /Lifecycle actions/ }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByText('Becomes Active automatically when the owner first signs in.')).toBeInTheDocument();
  });

  it('replaces the menu with the terminal note when Closed', async () => {
    mockApi(TENANT({ status: 'CLOSED', is_active: false }));
    renderDetail();
    expect(await screen.findByText('Closed is terminal. No further lifecycle actions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lifecycle actions/ })).not.toBeInTheDocument();
  });

  it('shows the view-only note and hides Domain for a read-only operator', async () => {
    mockApi(TENANT());
    renderDetail('/tenants/tn_01J8Q2NWX4?tab=domain', READ_ONLY_TENANT);
    expect(await screen.findByRole('note')).toHaveTextContent(
      /View only\.\s*You can view this tenant\. Lifecycle and domain changes need the Manage tenant lifecycle permission\./,
    );
    expect(screen.queryByRole('button', { name: /Lifecycle actions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Domain' })).not.toBeInTheDocument();
    // A hidden ?tab=domain falls back to Overview.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs through ?tab=', async () => {
    mockApi(TENANT());
    renderDetail();
    fireEvent.click(await screen.findByRole('tab', { name: 'Lifecycle & audit' }));
    expect(screen.getByTestId('location')).toHaveTextContent('?tab=lifecycle');
    expect(await screen.findByText('Activated')).toBeInTheDocument();
    expect(screen.getByText('Owner first sign-in')).toBeInTheDocument();
    expect(screen.queryByText('tenant.activated')).not.toBeInTheDocument();
  });

  it('shows the invite callout on a Provisioned tenant, gated on :provision', async () => {
    mockApi(TENANT({ status: 'PROVISIONED', is_active: false }), []);
    const resend = vi.spyOn(platformApi, 'resendOwnerInvite').mockResolvedValue({
      tenant_id: 'tn_01J8Q2NWX4',
      owner_user_id: 'u',
      owner_email: 'o@x.com',
      resent: true,
    });
    renderDetail();
    expect(await screen.findByText('Not yet invited.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Send owner invite' }));
    await waitFor(() => expect(resend).toHaveBeenCalled());
    expect(await screen.findByText('Owner invite sent to Northwind Logistics.')).toBeInTheDocument();
  });

  it('hides the callout action without :provision', async () => {
    mockApi(TENANT({ status: 'PROVISIONED', is_active: false }), []);
    renderDetail('/tenants/tn_01J8Q2NWX4', ['platform:tenant:read', 'platform:tenant:lifecycle:manage']);
    expect(await screen.findByText('Not yet invited.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /owner invite/ })).not.toBeInTheDocument();
  });

  it('suspends: from → to, consequence, required fields, toast and timeline refetch', async () => {
    mockApi(TENANT());
    const suspend = vi
      .spyOn(platformApi, 'suspend')
      .mockResolvedValue({ tenant_id: 'tn_01J8Q2NWX4', from: 'ACTIVE', to: 'SUSPENDED', status: 'SUSPENDED', changed: true });
    renderDetail('/tenants/tn_01J8Q2NWX4?tab=lifecycle');
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend — Northwind Logistics' });
    expect(within(dialog).getByText('Active')).toBeInTheDocument();
    expect(within(dialog).getByText('Suspended')).toBeInTheDocument();
    expect(within(dialog).getByText(/No one in this tenant can sign in/)).toBeInTheDocument();
    const commit = within(dialog).getByRole('button', { name: 'Suspend tenant' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Reason/ }), { target: { value: 'payment_overdue' } });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason details/ }), { target: { value: 'Invoice unpaid' } });
    expect(commit).toBeEnabled();
    const auditCalls = getAudit.mock.calls.length;
    fireEvent.click(commit);
    await waitFor(() =>
      expect(suspend).toHaveBeenCalledWith('tn_01J8Q2NWX4', { reasonCode: 'payment_overdue', reasonText: 'Invoice unpaid' }),
    );
    expect(await screen.findByText('Northwind Logistics is now suspended.')).toBeInTheDocument();
    await waitFor(() => expect(getAudit.mock.calls.length).toBeGreaterThan(auditCalls));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open on illegal_transition and on "already in that status"', async () => {
    mockApi(TENANT());
    const close = vi
      .spyOn(platformApi, 'startOffboarding')
      .mockRejectedValueOnce(new ApiError(422, 'Illegal', 'VALIDATION_ERROR', { reason: 'illegal_transition', from: 'CLOSED' }))
      .mockResolvedValueOnce({ tenant_id: 't', from: 'OFFBOARDING', to: 'OFFBOARDING', status: 'OFFBOARDING', changed: false });
    renderDetail('/tenants/tn_01J8Q2NWX4?tab=lifecycle');
    fireEvent.click(await screen.findByRole('button', { name: 'Start offboarding…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Retention policy/ }), { target: { value: 'standard_90d' } });
    fireEvent.change(within(dialog).getByLabelText(/Close at/), { target: { value: '2026-12-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start offboarding' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This change isn’t allowed from Closed.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start offboarding' }));
    expect(await within(dialog).findByText(/No change: this tenant is already offboarding\./)).toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('requires the terminal acknowledgement to close', async () => {
    mockApi(TENANT({ status: 'OFFBOARDING' }));
    renderDetail('/tenants/tn_01J8Q2NWX4?tab=lifecycle');
    fireEvent.click(await screen.findByRole('button', { name: 'Close tenant…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Reason/ }), { target: { value: 'offboarding_complete' } });
    const commit = within(dialog).getByRole('button', { name: 'Close tenant permanently' });
    expect(commit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand closing is terminal/ }));
    expect(commit).toBeEnabled();
  });

  it('shows the timeline error with Try again', async () => {
    mockApi(TENANT());
    getAudit.mockRejectedValueOnce(new Error('x'));
    renderDetail('/tenants/tn_01J8Q2NWX4?tab=lifecycle');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Activated')).toBeInTheDocument();
  });

  it('shows Tenant not found for a 404', async () => {
    vi.spyOn(platformApi, 'getTenant').mockRejectedValue(new ApiError(404, 'nf', 'NOT_FOUND'));
    vi.spyOn(platformApi, 'getTenantAudit').mockRejectedValue(new ApiError(404, 'nf', 'NOT_FOUND'));
    vi.spyOn(platformApi, 'getTenantSign').mockRejectedValue(new ApiError(404, 'nf', 'NOT_FOUND'));
    renderDetail();
    expect(await screen.findByText('Tenant not found')).toBeInTheDocument();
  });
});
