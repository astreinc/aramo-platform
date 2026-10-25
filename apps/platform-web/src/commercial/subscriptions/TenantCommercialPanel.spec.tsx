import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';

import {
  CR_NEW,
  CR_OPEN,
  NON_READERS,
  NOW,
  PV_TEAM_2,
  READERS,
  STRIPE_ROW,
  SUB_MERIDIAN,
  T_MERIDIAN,
  commercial,
  entitlement,
  heldFlag,
  installFetch,
  openRequest,
  world,
  writes,
  type World,
} from './subscriptions-test-data';

// CCP-B3 (PBD §5.3 B3 row: "tenant product tab actions (request change, cancel, grant or revoke
// product); held activations surfaced (Conv. C-8)"; mandatory "actions create change requests
// only"; CCP-UI v1.0 handoff §5.9) — Tenant › Commercial through the real App. Per role (6 + super
// admin), governed vs Stripe-owned display and gating, the held activation, the conversion flows
// (incl. DR-C2-1's refused committed row), the revoke request, and Apply only on
// `apply_actionable` (TD-B2-3). The write trace proves every write is a change-request call.

const PATH = `/tenants/${T_MERIDIAN}?tab=commercial`;

function renderAt(path = PATH) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const card = (name = 'Aramo Sign') => screen.findByRole('region', { name });
const action = async (label: string, name = 'Aramo Sign') => within(await card(name)).getByRole('button', { name: label });
const dialog = () => screen.findByRole('dialog');

/** The governed writes allowed from the tab: create / submit / apply / convert a change request. */
const GOVERNED = /^POST \/platform\/commercial\/change-requests(\/[0-9a-f-]+\/(submit|apply|convert))?$/;

const setup = () => {
  configureAuthConsumer('platform');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
};
const teardown = () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureAuthConsumer('recruiter');
};

async function fillAndSubmit(w: World, opts: { typed?: string; draft?: boolean } = {}) {
  const d = await dialog();
  fireEvent.change(within(d).getByLabelText('Reason'), { target: { value: 'Contract renewal agreed' } });
  fireEvent.change(within(d).getByLabelText('Evidence'), { target: { value: 'MSA-2026-014' } });
  if (opts.typed) fireEvent.change(within(d).getByLabelText(/to confirm/), { target: { value: opts.typed } });
  fireEvent.click(within(d).getByRole('button', { name: opts.draft ? 'Save as draft' : 'Submit for approval' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return w.calls.filter((c) => c.method === 'POST').map((c) => ({ path: c.path, body: c.body }));
}

describe('CCP-B3 Tenant › Commercial — per role (6 commercial roles + super_admin)', () => {
  beforeEach(setup);
  afterEach(teardown);

  for (const role of READERS) {
    it(`B3-T-ROLE ${role}: the Commercial tab shows one card per product (Aramo Sign, ATS, Portal, Intelligence)`, async () => {
      installFetch(world(), role);
      renderAt();
      expect(await screen.findByRole('tab', { name: 'Commercial' })).toHaveAttribute('aria-selected', 'true');
      for (const n of ['Aramo Sign', 'ATS', 'Portal', 'Intelligence']) expect(await card(n)).toBeInTheDocument();
      expect(within(await card('ATS')).getByText('No commercial plans yet — pricing not set. This product is granted as an entitlement only.')).toBeInTheDocument();
    });
  }

  for (const role of NON_READERS) {
    it(`B3-T-HIDDEN ${role}: no Commercial tab; ?tab=commercial falls back to Overview; the read is never called`, async () => {
      const w = world();
      installFetch(w, role);
      renderAt();
      expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Commercial' })).toBeNull();
      expect(w.calls.some((c) => c.path.includes('/commercial'))).toBe(false);
    });
  }

  it('B3-T-OPS commercial_ops: plan change, cancel and revoke enabled; support extension needs Support admin; no view-only note', async () => {
    installFetch(world(), 'commercial_ops');
    renderAt();
    for (const l of ['Request plan change…', 'Request cancel…', 'Revoke product…']) expect(await action(l)).toBeEnabled();
    expect(await action('Request support extension…')).toBeDisabled();
    expect(await action('Request support extension…')).toHaveAttribute('title', 'Needs the Support admin role.');
    expect(within(screen.getByTestId('tenant-commercial')).queryByRole('note')).toBeNull();
  });

  it('B3-T-SUPPORT support_admin: only the support extension is enabled', async () => {
    installFetch(world(), 'support_admin');
    renderAt();
    expect(await action('Request support extension…')).toBeEnabled();
    for (const l of ['Request plan change…', 'Request cancel…', 'Revoke product…']) {
      expect(await action(l)).toBeDisabled();
      expect(await action(l)).toHaveAttribute('title', 'Needs the Commercial ops role.');
    }
  });

  for (const role of ['platform_owner', 'finance_admin', 'read_only_auditor']) {
    it(`B3-T-VIEW ${role}: the design's view-only note; every action disabled with its role reason`, async () => {
      installFetch(world(), role);
      renderAt();
      expect(within(await screen.findByTestId('tenant-commercial')).getByRole('note')).toHaveTextContent('View only. You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin.');
      const c = await card();
      for (const b of within(c).getAllByRole('button')) expect(b).toBeDisabled();
    });
  }
});

describe('CCP-B3 Tenant › Commercial — governed vs Stripe-owned (handoff §5.9)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('B3-T-GOV a governed MANUAL row: facts, pinned version, contract commitment, allowance counts; provenance', async () => {
    installFetch(world(), 'commercial_ops');
    renderAt();
    const c = await card();
    expect(within(c).getByText('MANUAL · contract')).toBeInTheDocument();
    expect(within(c).getByText('Entitlement active')).toBeInTheDocument();
    expect(within(c).getByText('Granted by provisioning · 15 Mar 2025')).toBeInTheDocument();
    expect(within(c).getByText('Sign Scale')).toBeInTheDocument();
    expect(within(c).getByText('v1 · pinned')).toBeInTheDocument();
    expect(within(c).getByText('Contract CT-2025-014')).toBeInTheDocument();
    expect(within(c).getByText('4,410 of 10,000 envelopes')).toBeInTheDocument();
    expect(within(c).queryByTestId('managed-in-stripe')).toBeNull();
    expect(c.textContent).not.toMatch(/\$|USD/);
  });

  it('B3-T-STRIPE a Stripe-owned row is read-only: the Managed in Stripe box, Stripe domain reasons, only a governed conversion is offered', async () => {
    installFetch(world({ tenant: commercial({ subscription: STRIPE_ROW() }) }), 'commercial_ops');
    renderAt();
    const c = await card();
    expect(within(c).getByText('Managed in Stripe')).toBeInTheDocument();
    expect(within(c).getByTestId('managed-in-stripe')).toHaveTextContent("Managed in Stripe. The tenant pays through self-service checkout. Aramo doesn't edit this subscription.");
    // TD-C3-1 / C3 NOT DELIVERED: no live link-out without an available billing read.
    expect(within(c).queryAllByRole('link', { name: /Invoices/ })).toHaveLength(0);
    expect(await action('Request plan change…')).toBeDisabled();
    expect(await action('Request cancel…')).toBeDisabled();
    expect(within(c).getByText('Managed in Stripe. The tenant changes plans in Stripe checkout.')).toBeInTheDocument();
    expect(within(c).getByText('Managed in Stripe. Cancellation happens in Stripe.')).toBeInTheDocument();
    expect(await action('Request conversion to MANUAL…')).toBeEnabled();
  });

  it('B3-T-INVOICE with an AVAILABLE billing read, Invoices links to the provider-hosted page (TD-C3-1); the other three stay unlinked', async () => {
    const w = world({ tenant: commercial({ subscription: STRIPE_ROW() }) });
    const spy = installFetch(w, 'commercial_ops');
    const base = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.includes('/billing-status')) return new Response(JSON.stringify({ availability: 'AVAILABLE', invoices: [{ hosted_url: 'https://invoice.stripe.com/i/test_1', total_minor: 5900 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return base(input, init);
    });
    renderAt();
    const link = await within(await card()).findByRole('link', { name: 'Invoices ↗' });
    expect(link).toHaveAttribute('href', 'https://invoice.stripe.com/i/test_1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect((await card()).textContent).not.toMatch(/59|\$/);
    expect(within(await card()).queryByRole('link', { name: /Payment methods|Proration|Cancellation/ })).toBeNull();
  });
});

describe('CCP-B3 Tenant › Commercial — held activation (Conversion Rule C-8, operator side)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('B3-T-HELD the hold is surfaced (role=alert) with the release request for commercial_ops; the release is a CONVERSION change request (TO_GOVERNED, the held ref)', async () => {
    const w = world({ tenant: commercial({ flags: [heldFlag()] }) });
    installFetch(w, 'commercial_ops');
    renderAt();
    const held = await screen.findByTestId('held-activation');
    expect(held).toHaveAttribute('role', 'alert');
    expect(held).toHaveTextContent('Reconciliation flag · self-service checkout blocked.');
    expect(held).toHaveTextContent('The MANUAL subscription was not replaced.');
    expect(held).toHaveTextContent('Needs a Commercial ops release request.');
    fireEvent.click(within(held).getByRole('button', { name: 'Request reconciliation release…' }));
    expect(within(await dialog()).getByRole('heading', { name: 'Request reconciliation release · Meridian Partners' })).toBeInTheDocument();
    const posts = await fillAndSubmit(w);
    expect(posts[0]).toEqual({
      path: '/platform/commercial/change-requests',
      body: expect.objectContaining({ action_type: 'CONVERSION', tenant_id: T_MERIDIAN, product_key: 'sign', payload: { direction: 'TO_GOVERNED', held_subscription_ref: 'sub_held_1', governed_subscription_id: SUB_MERIDIAN }, reason: 'Contract renewal agreed\n\nEvidence: MSA-2026-014' }),
    });
    expect(posts[1]!.path).toBe(`/platform/commercial/change-requests/${CR_NEW}/submit`);
    expect(writes(w).every((x) => GOVERNED.test(x))).toBe(true);
  });

  it('B3-T-HELD-2 the hold for a viewer: shown, no release action; a release in APPLYING reads "sent to Stripe — awaiting confirmation"', async () => {
    installFetch(world({ tenant: commercial({ flags: [heldFlag({ conversion: { change_request_id: CR_OPEN, state: 'APPLYING', direction: 'TO_GOVERNED' } })] }) }), 'read_only_auditor');
    renderAt();
    const held = await screen.findByTestId('held-activation');
    expect(held).toHaveTextContent('Release sent to Stripe — awaiting confirmation:');
    expect(within(held).getByRole('link', { name: 'CR-0190B300' })).toHaveAttribute('href', `/commercial/approvals?request=${CR_OPEN}`);
    expect(within(held).queryByRole('button')).toBeNull();
  });
});

describe('CCP-B3 Tenant › Commercial — an expired release (B5-R: APPLY_EXPIRED on CONVERSION)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('B3-T-HELD-3 a release request that reached APPLY_EXPIRED is shown as such and a new release can be requested', async () => {
    installFetch(world({ tenant: commercial({ flags: [heldFlag({ conversion: { change_request_id: CR_OPEN, state: 'APPLY_EXPIRED', direction: 'TO_GOVERNED' } })] }) }), 'commercial_ops');
    renderAt();
    const held = await screen.findByTestId('held-activation');
    expect(held).toHaveTextContent('Release request apply expired; needs a new Commercial ops release request:');
    expect(within(held).getByRole('button', { name: 'Request reconciliation release…' })).toBeEnabled();
  });
});

describe('CCP-B3 Tenant › Commercial — requests (every action is a change request)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('B3-T-PLAN plan change → SUBSCRIPTION_CHANGE (pinned plan version), submitted; prices only inside the dialog', async () => {
    const w = world();
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await action('Request plan change…'));
    const d = await dialog();
    expect(within(d).getByLabelText('Discount (%)')).toBeDisabled();
    const sel = await within(d).findByLabelText('New plan');
    await waitFor(() => expect(within(sel).getAllByRole('option').length).toBe(2));
    fireEvent.change(sel, { target: { value: PV_TEAM_2 } });
    expect(within(d).getByText('Approval chain')).toBeInTheDocument();
    expect(within(d).getByText('Below threshold')).toBeInTheDocument();
    expect(within(d).getByText('policy v1 · 72 h window')).toBeInTheDocument();
    const posts = await fillAndSubmit(w);
    expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'SUBSCRIPTION_CHANGE', payload: { subscription_id: SUB_MERIDIAN, plan_key: 'aramo-sign-team-v1', plan_version_id: PV_TEAM_2 } }));
    expect(posts).toHaveLength(2);
    expect(await screen.findByRole('status')).toHaveTextContent('Submitted for approval.');
  });

  it('B3-T-DRAFT Save as draft creates the request and does not submit it', async () => {
    const w = world();
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await action('Request plan change…'));
    const sel = await within(await dialog()).findByLabelText('New plan');
    await waitFor(() => expect(within(sel).getAllByRole('option').length).toBe(2));
    fireEvent.change(sel, { target: { value: PV_TEAM_2 } });
    const posts = await fillAndSubmit(w, { draft: true });
    expect(posts.map((p) => p.path)).toEqual(['/platform/commercial/change-requests']);
  });

  it('B3-T-CANCEL cancel of a contract-linked row → SUBSCRIPTION_END with contract_end; typed tenant name required', async () => {
    const w = world();
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await action('Request cancel…'));
    const d = await dialog();
    fireEvent.change(within(d).getByLabelText('Reason'), { target: { value: 'Contract ends' } });
    fireEvent.change(within(d).getByLabelText('Evidence'), { target: { value: 'Termination letter' } });
    expect(within(d).getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
    const posts = await fillAndSubmit(w, { typed: 'Meridian Partners' });
    expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'SUBSCRIPTION_END', payload: { subscription_id: SUB_MERIDIAN, contract_end: { contract_id: expect.any(String), documents: [], evidence_ref: 'MSA-2026-014' } } }));
  });

  it('B3-T-REVOKE revoke → ENTITLEMENT_REVOKE {capabilities: [sign]} after typing the tenant name', async () => {
    const w = world();
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await action('Revoke product…'));
    expect(within(await dialog()).getByText('People in Meridian Partners lose access to Aramo Sign once approved. Data is kept.')).toBeInTheDocument();
    const posts = await fillAndSubmit(w, { typed: 'Meridian Partners' });
    expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'ENTITLEMENT_REVOKE', payload: { capabilities: ['sign'] } }));
    expect(writes(w).every((x) => GOVERNED.test(x))).toBe(true);
  });

  it('B3-T-GRANT a revoked product shows its revoke provenance and offers Grant → ENTITLEMENT_GRANT {core, sign}', async () => {
    const w = world({ tenant: commercial({ entitlement: entitlement({ state: 'REVOKED', revoked_at: '2026-10-02T00:00:00.000Z', revoke_change_request_id: CR_OPEN }) }) });
    installFetch(w, 'commercial_ops');
    renderAt();
    expect(within(await card()).getByText('Revoked 2 Oct 2026 · CR-0190B300 · was granted by provisioning')).toBeInTheDocument();
    fireEvent.click(await action('Grant product…'));
    const posts = await fillAndSubmit(w);
    expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'ENTITLEMENT_GRANT', payload: { capabilities: ['core', 'sign'] } }));
  });

  it('B3-T-CONVERT a Stripe-owned row → CONVERSION TO_GOVERNED (the self-service row and the target plan version)', async () => {
    const w = world({ tenant: commercial({ subscription: STRIPE_ROW() }) });
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await action('Request conversion to MANUAL…'));
    const sel = await within(await dialog()).findByLabelText('New plan');
    await waitFor(() => expect(within(sel).getAllByRole('option').length).toBe(2));
    const posts = await fillAndSubmit(w);
    expect(posts[0]!.body).toEqual(expect.objectContaining({ action_type: 'CONVERSION', payload: expect.objectContaining({ direction: 'TO_GOVERNED', subscription_id: STRIPE_ROW().subscription_id }) }));
  });

  it('B3-T-COMMIT DR-C2-1: a committed self-service row cannot be converted; the reason names FINANCIAL_TREATMENT_UNDEFINED', async () => {
    installFetch(world({ tenant: commercial({ subscription: STRIPE_ROW({ commitment_end: '2027-02-10T00:00:00.000Z' }) }) }), 'commercial_ops');
    renderAt();
    expect(await action('Request conversion to MANUAL…')).toBeDisabled();
    expect(within(await card()).getByText(/Inside its commitment term until 10 Feb 2027: .*FINANCIAL_TREATMENT_UNDEFINED/)).toBeInTheDocument();
  });

  it('B3-T-OPEN an open request (Q14) blocks the other actions and links the drawer', async () => {
    installFetch(world({ tenant: commercial({ open_request: openRequest() }) }), 'commercial_ops');
    renderAt();
    const strip = await screen.findByTestId('open-request');
    expect(strip).toHaveTextContent('Open request CR-0190B300 · Plan change · pending approval. Other requests on this product wait until it closes.');
    expect(await action('Request plan change…')).toBeDisabled();
  });
});

describe('CCP-B3 Tenant › Commercial — Apply only via apply_actionable (TD-B2-3)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('B3-T-APPLY-0 an APPROVED request with apply_actionable false: no Apply (even for its requester state)', async () => {
    installFetch(world({ tenant: commercial({ open_request: openRequest({ state: 'APPROVED' }) }), actionable: { [CR_OPEN]: false } }), 'commercial_ops');
    renderAt();
    await screen.findByTestId('open-request');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Apply|Retry apply)$/ })).toBeNull());
  });

  it('B3-T-APPLY-1 apply_actionable true: Apply calls the governed apply route', async () => {
    const w = world({ tenant: commercial({ open_request: openRequest({ state: 'APPROVED' }) }), actionable: { [CR_OPEN]: true } });
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(writes(w)).toContain(`POST /platform/commercial/change-requests/${CR_OPEN}/apply`));
  });

  it('B3-T-APPLY-2 a CONVERSION applies through /convert; the C2 refusal FINANCIAL_TREATMENT_UNDEFINED is shown (DR-C2-1)', async () => {
    const w = world({
      tenant: commercial({ subscription: STRIPE_ROW(), open_request: openRequest({ action_type: 'CONVERSION', state: 'APPLY_FAILED' }) }),
      actionable: { [CR_OPEN]: true },
      onApply: () => ({ status: 409, body: { error: { code: 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', message: 'failed', details: { reason: 'apply_failed', failure: 'FINANCIAL_TREATMENT_UNDEFINED', attempt: 2, request_state: 'APPLY_FAILED' } } } }),
    });
    installFetch(w, 'commercial_ops');
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry apply' }));
    const alert = await screen.findByText(/^Apply failed: FINANCIAL_TREATMENT_UNDEFINED\./);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(alert).toHaveTextContent('inside its commitment term');
    expect(writes(w)).toContain(`POST /platform/commercial/change-requests/${CR_OPEN}/convert`);
    expect(writes(w).some((x) => x.endsWith('/apply'))).toBe(false);
  });

  it('B3-T-PENDING a conversion awaiting Stripe reads "sent to Stripe — awaiting confirmation" and is never shown as applied', async () => {
    installFetch(world({ tenant: commercial({ subscription: STRIPE_ROW(), open_request: openRequest({ action_type: 'CONVERSION', state: 'APPLYING' }) }), pendingProvider: { [CR_OPEN]: true } }), 'commercial_ops');
    renderAt();
    await waitFor(() => expect(screen.getByTestId('open-request')).toHaveTextContent('Subscription conversion · sent to Stripe — awaiting confirmation.'));
    expect(screen.getByTestId('open-request').textContent).not.toMatch(/Applied/);
  });
});
