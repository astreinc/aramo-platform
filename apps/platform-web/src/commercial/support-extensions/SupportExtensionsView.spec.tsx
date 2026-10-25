import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';

import { ME, NOW, OTHER, POLICY, SUB, TENANT, extension, installFetch, request, world, type World } from './support-extension-test-data';

// CCP-B6 (PBD §5.3 B6 row; CCP-UI v1.0 handoff §5.9, §5.10, §2) — the support workflow through
// the real App (router, shell, route gate) with the platform-admin routes answered by a fetch
// mock. Per role: support_admin creates; Finance approves escalations (in the Approvals drawer,
// linked); everyone else with the read scope is view-only; super_admin and catalog_manager are
// refused at the route (the backend refuses them too: CCP-A8 §4 matrix). Flows: the in-bound
// exception, the breach → escalation (never applied), the removal request, the requester-only
// Apply (TD-B2-3).

const PATH = `/commercial/support-extensions?tenant=${TENANT}`;

function renderAt(path = PATH) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const card = () => screen.findByRole('region', { name: 'Aramo Sign' });
const extendButton = async () => within(await card()).getByRole('button', { name: 'Request support extension…' });

describe('CCP-B6 support extensions — per-role visibility (6 commercial roles + super_admin)', () => {
  beforeEach(() => {
    configureAuthConsumer('platform');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureAuthConsumer('recruiter');
  });

  it('B6-V-SUPPORT support_admin can request: the action is enabled and no view-only note shows', async () => {
    installFetch(world(), 'support_admin');
    renderAt();
    expect(await extendButton()).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();
  });

  for (const role of ['platform_owner', 'finance_admin', 'commercial_ops', 'read_only_auditor']) {
    it(`B6-V-VIEW ${role} sees the workflow view-only: the note names the Support admin role (design copy), the action is disabled with its reason`, async () => {
      installFetch(world({ list: { ...world().list, extensions: [extension()] } }), role);
      renderAt();
      const btn = await extendButton();
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Needs the Support admin role.');
      expect(screen.getByRole('note')).toHaveTextContent('View only. You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin.');
      // The overlay is visible; its removal is not offered.
      expect(screen.getByRole('region', { name: /^Exception: \+10 day support extension/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request removal…' })).toBeNull();
    });
  }

  for (const role of ['catalog_manager', 'super_admin']) {
    it(`B6-V-DENIED ${role} (no platform:subscription:read) gets the in-shell access-denied state; the list route is never called`, async () => {
      const w = world();
      installFetch(w, role);
      renderAt();
      const denied = await screen.findByTestId('access-denied');
      expect(within(denied).getAllByText('platform:subscription:read').length).toBeGreaterThan(0);
      expect(w.calls.some((c) => c.path.startsWith('/platform/commercial/support-extensions'))).toBe(false);
    });
  }
});

describe('CCP-B6 support extensions — flows', () => {
  beforeEach(() => {
    configureAuthConsumer('platform');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureAuthConsumer('recruiter');
  });

  async function openDialog(w: World) {
    installFetch(w, 'support_admin');
    renderAt();
    fireEvent.click(await extendButton());
    return screen.findByRole('dialog', { name: 'Request support extension · Fernhill Studio' });
  }

  it('B6-F-IN in bounds: the green preview, "Apply extension (exception)", ONE POST; then the overlay with the EXCEPTION tag and the exception flag', async () => {
    const w = world();
    w.onExtend = () => {
      w.list = { ...w.list, extensions: [extension({ id: '0190c000-0000-7000-8000-0000000b6e43', days: 7, applied_at: NOW.toISOString(), context: { policy_version_number: 1, clause: POLICY.clause, roles_at_apply: ['support_admin'], counters: { requested_days: 7, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: 7 } } })] };
      return { status: 201, body: { outcome: 'APPLIED', replayed: false, request: request({ kind: 'EXCEPTION', state: 'APPLIED' }), extension: w.list.extensions[0], application: {}, decision: { within_bounds: true, breaches: [], eligibility: [], counters: {}, clause: {} } } };
    };
    const dlg = await openDialog(w);
    const status = within(dlg).getByRole('status');
    expect(status).toHaveTextContent('Within bounds — applies now as an exception, with zero approvals');
    expect(status).toHaveTextContent('Actor: Kwame Mensah · roles: Support admin');
    expect(status).toHaveTextContent('Uses in the 90-day window: 0 → 1');
    expect(status).toHaveTextContent('Cumulative days: 0 → 7 (cap 30)');
    expect(within(dlg).getByText('Policy v1: up to 14 days, once per tenant per 90 days, 30 days cumulative.')).toBeInTheDocument();
    expect(within(dlg).queryByTestId('chain-preview')).toBeNull();
    const commit = within(dlg).getByRole('button', { name: 'Apply extension (exception)' });
    expect(commit).toBeDisabled(); // reason required
    fireEvent.change(within(dlg).getByLabelText('Reason'), { target: { value: 'Billing contact on leave' } });
    fireEvent.click(commit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const posts = w.calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', path: '/platform/commercial/support-extensions', body: { tenant_id: TENANT, subscription_id: SUB, requested_days: 7, reason: 'Billing contact on leave', idempotency_key: expect.stringMatching(/^b6-ext:/), product_key: 'sign' } }]);
    expect(await screen.findByRole('region', { name: /^Exception: \+7 day support extension · applied with zero approvals/ })).toBeInTheDocument();
    expect(screen.getByText('Extension · exception')).toBeInTheDocument();
  });

  it('B6-F-ESC a breach (20 days): the amber preview + Finance chain + "Submit for approval"; the server escalates; nothing applies; the request links to the Approvals drawer', async () => {
    const w = world();
    const esc = request({ id: '0190c000-0000-7000-8000-0000000b6a99' });
    w.onExtend = () => {
      w.requests = [esc];
      return { status: 201, body: { outcome: 'ESCALATED', replayed: false, request: esc, extension: null, application: null, decision: { within_bounds: false, breaches: ['LENGTH'], eligibility: [], counters: {}, clause: { support_extension_max_days: 14 } } } };
    };
    const dlg = await openDialog(w);
    fireEvent.change(within(dlg).getByLabelText('Extension (days)'), { target: { value: '20' } });
    const status = within(dlg).getByRole('status');
    expect(status).toHaveTextContent('Out of bounds — escalates to approval (Finance)');
    expect(status).toHaveTextContent('More than 14 days in one extension.');
    expect(within(dlg).getByTestId('chain-preview')).toHaveTextContent('Approval chainBelow thresholdFinancepolicy v1 · 72 h window');
    fireEvent.change(within(dlg).getByLabelText('Reason'), { target: { value: 'The practice moved offices' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Submit for approval' }));
    const notice = await screen.findByText(/^Escalated to Finance — nothing was applied\. More than 14 days in one extension\./);
    expect(within(notice).getByRole('link', { name: '0190C000' })).toHaveAttribute('href', `/commercial/approvals?request=${esc.id}`);
    // No overlay, and the open request now holds the slot: the action is disabled.
    expect(screen.queryByRole('region', { name: /support extension ·/ })).toBeNull();
    await waitFor(async () => expect(await extendButton()).toBeDisabled());
    expect(screen.getByText(/· Support extension · pending approval\. Other requests on this product wait until it closes\./)).toBeInTheDocument();
    // The escalated request is never applied from the console by its maker while pending.
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('B6-F-REMOVE support_admin requests a removal: a SUPPORT_EXTENSION change request with operation REMOVE, submitted to Finance; the overlay stays', async () => {
    const w = world({ list: { ...world().list, extensions: [extension()] } });
    installFetch(w, 'support_admin');
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Request removal…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Request removal · EXT-0190C000' });
    expect(within(dlg).getByTestId('chain-preview')).toHaveTextContent('Below thresholdFinance');
    const commit = within(dlg).getByRole('button', { name: 'Submit for approval' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText('Reason'), { target: { value: 'Granted in error' } });
    fireEvent.click(commit);
    await screen.findByText(/The overlay stays until Finance signs and you apply it\./);
    const posts = w.calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => p.path)).toEqual(['/platform/commercial/change-requests', '/platform/commercial/change-requests/0190c000-0000-7000-8000-0000000b6a77/submit']);
    expect(posts[0]?.body).toMatchObject({ action_type: 'SUPPORT_EXTENSION', tenant_id: TENANT, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: extension().id }, reason: 'Granted in error' });
    expect(screen.getByRole('region', { name: /^Exception: \+10 day support extension/ })).toBeInTheDocument();
  });

  it('B6-F-APPLY TD-B2-3: Apply shows only for the requester of an APPROVED request whose read is apply_actionable; it calls …/apply', async () => {
    const approved = request({ state: 'APPROVED', approved_at: NOW.toISOString() });
    const w = world({ requests: [approved], actionable: { [approved.id]: true } });
    installFetch(w, 'support_admin');
    renderAt();
    const apply = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(apply);
    await waitFor(() => expect(w.calls.some((c) => c.method === 'POST' && c.path === `/platform/commercial/change-requests/${approved.id}/apply`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull());
  });

  it('B6-F-APPLY-NOT no Apply when the read says not actionable, or for another requester, or for the Finance approver', async () => {
    const mine = request({ state: 'APPROVED' });
    installFetch(world({ requests: [mine], actionable: { [mine.id]: false } }), 'support_admin');
    renderAt();
    await screen.findByText(/· Support extension · approved\./);
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    vi.restoreAllMocks();
  });

  it('B6-F-APPLY-OTHER another requester’s approved request: no Apply even if the flag were true', async () => {
    const theirs = request({ state: 'APPROVED', requested_by: OTHER });
    installFetch(world({ requests: [theirs], actionable: { [theirs.id]: true } }), 'support_admin');
    renderAt();
    await screen.findByText(/· Support extension · approved\./);
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('B6-F-FINANCE finance_admin sees the pending escalation linked to the Approvals drawer, with no create, removal or apply action', async () => {
    const esc = request({ requested_by: OTHER });
    installFetch(world({ requests: [esc], list: { ...world().list, extensions: [extension({ applied_by: OTHER })] } }), 'finance_admin');
    renderAt();
    const link = await screen.findByRole('link', { name: '0190C000' });
    expect(link).toHaveAttribute('href', `/commercial/approvals?request=${esc.id}`);
    expect(await extendButton()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Request removal…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    // Someone else's overlay: the actor is shown by reference (no roster read, R-13).
    expect(screen.getByText(/^0190C000 · 2026-10-03 16:40 UTC$/)).toBeInTheDocument();
    expect(ME).not.toBe(OTHER);
  });

  it('B6-F-NOSUB no open base subscription: the designed line and the domain reason under the disabled action', async () => {
    installFetch(world({ list: { extensions: [], subscriptions: [], policy: world().list.policy } }), 'support_admin');
    renderAt();
    expect(await screen.findByText('No open base subscription.')).toBeInTheDocument();
    expect(await extendButton()).toBeDisabled();
    expect(screen.getByText('Request support extension:').parentElement).toHaveTextContent('Request support extension: No open subscription.');
  });

  it('B6-F-PICK without ?tenant the designed empty state asks for a tenant; choosing one loads it', async () => {
    const w = world();
    installFetch(w, 'support_admin');
    renderAt('/commercial/support-extensions');
    expect(await screen.findByText('Choose a tenant', { selector: '.pw-empty__title' })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Tenant'), { target: { value: TENANT } });
    expect(await extendButton()).toBeEnabled();
  });
});
