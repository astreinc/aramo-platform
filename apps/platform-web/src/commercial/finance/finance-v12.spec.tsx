import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformApi } from '../../platform-api';
import { alertsApi, type CommercialAlert } from '../alerts/alerts-api';
import { ALERTS_FOOT, AlertsView } from '../alerts/AlertsView';
import { subscriptionsApi } from '../subscriptions/subscriptions-api';
import { supportExtensionApi } from '../support-extensions/support-extension-api';
import { sessionFor, type FixtureRole } from '../test-fixtures';
import { ConsumptionView } from '../usage/ConsumptionView';
import { usageApi, type UsagePeriod, type UsageReconciliation } from '../usage/usage-api';

import { BillingReconciliationView } from './BillingReconciliationView';
import { financeApi, type BillingCommand, type OutstandingItem, type RenewalItem, type RevenueReport } from './finance-api';
import { OutstandingPaymentsView } from './OutstandingPaymentsView';
import { RenewalsView } from './RenewalsView';
import { ANNUAL_LABEL, LIST_PRICE_NOTE, MONTHLY_LABEL, RevenueView } from './RevenueView';

// CCP-UI-V12 — Finance › Renewals, Outstanding payments, Billing reconciliation, Revenue; Usage ›
// Consumption; Operations › Alerts (CCP-UI v1.1 §13; v1.2 §17), against mocked typed clients.
// Holder = platform:billing:amount:read (platform_owner, finance_admin, read_only_auditor); the
// server decides what is withheld, the console renders the marker it receives.

const AS_OF = '2026-10-24T14:00:00.000Z';
const T1 = 'cb300000-0000-7000-8000-0000000000a1';
const T2 = 'cb300000-0000-7000-8000-0000000000a5';
const price = (amount: number | null, reason: string | null = null) => ({ list_price: amount === null ? null : { amount_minor: amount, currency: 'USD' as const, billing_interval: 'MONTH' }, unpriced_reason: reason, price_source: 'PINNED_PLAN_VERSION', plan_version_id: 'pv' });

function joins() {
  vi.spyOn(platformApi, 'listTenants').mockResolvedValue({
    tenants: [
      { id: T1, name: 'Halcyon Health', kind: 'BUSINESS', slug: 'halcyon', status: 'ACTIVE', status_reason_code: null, status_changed_at: '', is_active: true, created_at: '', activated_at: null, suspended_at: null },
      { id: T2, name: 'Fernhill Studio', kind: 'BUSINESS', slug: 'fernhill', status: 'ACTIVE', status_reason_code: null, status_changed_at: '', is_active: true, created_at: '', activated_at: null, suspended_at: null },
    ],
  });
  vi.spyOn(subscriptionsApi, 'workbench').mockResolvedValue({ as_of: AS_OF, rows: [] });
}

const wrap = (el: JSX.Element) => render(<MemoryRouter>{el}</MemoryRouter>);

beforeEach(joins);
afterEach(() => vi.restoreAllMocks());

const renewal = (o: Partial<RenewalItem>): RenewalItem => ({
  subscription_id: 's1', tenant_id: T1, tenant_name: 'Halcyon Health', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'enterprise', plan_name: 'Enterprise', version_number: 1, grandfathered: false,
  renewal_kind: 'COMMITMENT_END', renewal_at: '2026-12-08T00:00:00.000Z', days_until: 45, lapsed: false, commitment_months: 36, cancel_at_period_end: false, cancel_requested_within_commitment: false, ...price(null, 'CONTRACT_PRICED'), ...o,
});

describe('Finance › Renewals (§13.1; W-1)', () => {
  const report = (items: RenewalItem[]) => ({ as_of: AS_OF, within_days: 90, currency: 'USD' as const, billing_provider_mode: 'test', tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }, items, counts: { items: items.length, lapsed: 0, commitment_end: 0, period_end: 0 } });

  it('V12-RN-1 W-1: a published list price is shown to a non-holder (commercial_ops); a contract-priced row keeps WithheldPrice; no WithheldAmount; tax box above', async () => {
    vi.spyOn(financeApi, 'renewals').mockResolvedValue(report([renewal({}), renewal({ subscription_id: 's2', tenant_id: T2, tenant_name: 'Fernhill Studio', source: 'SELF_SERVICE', renewal_kind: 'PERIOD_END', renewal_at: '2026-10-22T00:00:00.000Z', days_until: -2, lapsed: true, ...price(1900) })]));
    wrap(<RenewalsView />);
    expect(await screen.findByText('$19 / month')).toBeInTheDocument();
    expect(screen.getByText('Reason: contract-priced')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount withheld: finance access required')).toBeNull();
    expect(screen.getByTestId('not-enabled')).toHaveTextContent('Tax not enabled — pending Stripe Tax registration.');
    expect(screen.getByText('Lapsed 2 d ago')).toBeInTheDocument();
    expect(screen.getByText('45 days left')).toBeInTheDocument();
    expect(screen.getByTestId('renewals-count')).toHaveTextContent('2 in view · 1 lapsed');
    // Chronological, no totals.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Fernhill Studio');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include lapsed' }));
    expect(screen.getByTestId('renewals-count')).toHaveTextContent('1 in view · 0 lapsed');
  });

  it('V12-RN-2 the horizon refetches; an empty horizon shows the designed empty state', async () => {
    const spy = vi.spyOn(financeApi, 'renewals').mockResolvedValue(report([]));
    wrap(<RenewalsView />);
    expect(await screen.findByText('No renewals in this horizon')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Horizon' }), { target: { value: '180' } });
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(180));
  });
});

const outstanding = (o: Partial<OutstandingItem>): OutstandingItem => ({
  subscription_id: 's5', tenant_id: T2, tenant_name: 'Fernhill Studio', product_key: 'sign', source: 'SELF_SERVICE', status: 'PAST_DUE', plan_key: 'starter', version_number: 1, billing_subscription_ref: 'sub_1', status_since: null,
  grace_until: '2026-10-29T00:00:00.000Z', grace_state: 'IN_GRACE', current_period_end: null, amount_due_reason: 'INVOICE_READ_NOT_DELIVERED', ...price(1900), ...o,
});

describe('Finance › Outstanding payments (§13.2; §17.2)', () => {
  const report = (items: OutstandingItem[]) => ({ as_of: AS_OF, currency: 'USD' as const, billing_provider_mode: 'test', tax: { enabled: false }, items, counts: { items: items.length, past_due: 1, incomplete: 0, in_grace: 1, grace_ended: 0, no_grace_date: 0 } });
  const billing = (o: { availability: string; due?: boolean }) =>
    vi.spyOn(subscriptionsApi, 'invoiceLink').mockResolvedValue({ availability: o.availability, hosted_url: null, amount_withheld: true, payment_due: o.due ?? false, payment_overdue: false, tax: { enabled: false } });

  it.each<[FixtureRole, boolean]>([
    ['platform_owner', true],
    ['finance_admin', true],
    ['read_only_auditor', true],
    ['commercial_ops', false],
    ['support_admin', false],
  ])('V12-OP-1 %s: the amount note follows amount-read (holder %s)', async (role, holder) => {
    vi.spyOn(financeApi, 'outstanding').mockResolvedValue(report([outstanding(holder ? { amount_due: null } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' })]));
    vi.spyOn(supportExtensionApi, 'list').mockResolvedValue({ extensions: [], subscriptions: [], policy: null });
    billing({ availability: 'AVAILABLE', due: true });
    wrap(<OutstandingPaymentsView session={sessionFor(role)} />);
    const cell = await screen.findByTestId('outstanding-amount');
    if (holder) {
      expect(screen.getByRole('status')).toHaveTextContent('Amount due not yet available.');
      expect(cell).toHaveTextContent('Not yet available');
    } else {
      expect(screen.getByRole('note')).toHaveTextContent('Amounts withheld for your role.');
      expect(within(cell).getByLabelText('Amount withheld: finance access required')).toBeInTheDocument();
    }
    // FA-4 from the C3 read (AVAILABLE): every billing reader sees the due pill.
    expect(await within(cell).findByText('Due')).toBeInTheDocument();
    expect(screen.getByText('Past due · in grace')).toBeInTheDocument();
  });

  it('V12-OP-2 no due pill when the C3 read is not AVAILABLE (no false "Not due"); the live extension overlay links to Support extensions', async () => {
    vi.spyOn(financeApi, 'outstanding').mockResolvedValue(report([outstanding({ amount_withheld: 'FINANCE_SCOPE_REQUIRED' })]));
    vi.spyOn(supportExtensionApi, 'list').mockResolvedValue({
      extensions: [{ id: 'cc7e0000-0000-7000-8000-000000000042', tenant_id: T2, product_key: 'sign', subscription_id: 's5', change_request_id: 'c', is_exception: true, days: 10, grace_until_at_apply: null, base_until: AS_OF, extends_until: '2026-11-08T00:00:00.000Z', policy_version_id: 'p', applied_by: 'u', applied_at: '2026-10-20T00:00:00.000Z', removed_at: null, removed_by: null, remove_change_request_id: null, active: true }],
      subscriptions: [],
      policy: null,
    });
    billing({ availability: 'BILLING_UNAVAILABLE' });
    wrap(<OutstandingPaymentsView session={sessionFor('support_admin')} />);
    expect(await screen.findByText('EXT-CC7E0000 · +10 days')).toHaveAttribute('href', `/commercial/support-extensions?tenant=${T2}`);
    expect(screen.queryByTestId('payment-due')).toBeNull();
  });

  it('V12-OP-3 empty', async () => {
    vi.spyOn(financeApi, 'outstanding').mockResolvedValue(report([]));
    wrap(<OutstandingPaymentsView session={sessionFor('finance_admin')} />);
    expect(await screen.findByText('Nothing outstanding')).toBeInTheDocument();
  });
});

describe('Finance › Billing reconciliation (§13.3; D-2; §17.2)', () => {
  const cmd = (o: Partial<BillingCommand>): BillingCommand => ({
    id: 'cb300000-0000-7000-8000-00000000c001', provider: 'stripe', command_kind: 'CREDIT_GRANT', change_request_id: null, self_service_request_id: null, tenant_id: T1, product_key: 'sign', params: {}, state: 'FAILED', pending_provider: true, attempts: 3,
    failure: { code: 'PROVIDER_REFUSED' }, provider_accepted_at: null, confirmed_at: null, failed_at: null, created_at: '2026-10-22T10:00:00.000Z', updated_at: AS_OF, ...o,
  });
  function mockAll(params: Record<string, unknown>, stuckMinutes: number | null) {
    vi.spyOn(financeApi, 'reconciliation').mockResolvedValue({
      as_of: AS_OF, currency: 'USD', billing_provider_mode: 'test', tax: { enabled: false }, status: 'EXCEPTIONS',
      subscriptions: [{ subscription_id: 's1', tenant_id: T1, tenant_name: 'Halcyon Health', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'enterprise', version_number: 1, version_status: 'PUBLISHED', grandfathered: false, billing_subscription_ref: null, provider_price_ref: null, entitlement: { expected: ['sign'], present: [], missing: ['sign'] }, open_flag_reasons: [], unconfirmed_command_ids: [], discrepancies: ['ENTITLEMENT_MISSING'], ...price(null, 'CONTRACT_PRICED') }],
      entitled_without_subscription: [], held_activations: [], other_open_flags: [],
      counts: { open_subscriptions: 1, subscriptions_with_discrepancy: 1, entitled_without_subscription: 0, held_activations: 0, other_open_flags: 0, unconfirmed_commands: 0, failed_commands: 1, failed_inbox_events: 0, unprocessed_inbox_events: 0, exceptions: 2 },
    });
    vi.spyOn(financeApi, 'commands').mockImplementation(async (state) => ({
      commands: state === 'FAILED' ? [cmd({ params })] : [cmd({ id: 'cb300000-0000-7000-8000-00000000c002', state: 'PENDING_PROVIDER', command_kind: 'SUBSCRIPTION_CANCEL', failure: null, provider_accepted_at: '2026-10-23T08:00:00.000Z' })],
      next_cursor: null,
    }));
    vi.spyOn(financeApi, 'inbox').mockResolvedValue({ events: [], next_cursor: null });
    if (stuckMinutes === null) vi.spyOn(alertsApi, 'billingMetrics').mockRejectedValue(new ApiError(500, 'x', 'X'));
    else vi.spyOn(alertsApi, 'billingMetrics').mockResolvedValue({ as_of: AS_OF, commands_by_state: {}, commands_pending_provider_past_threshold: 1, webhook_inbox_by_status: {}, open_reconciliation_flags_by_reason: {}, open_alerts_by_type: {}, thresholds: { pending_provider_stuck_minutes: stuckMinutes, approval_expiry_lead_minutes: 720 } });
  }

  it('V12-RC-1 the Exceptions tile is the server count; the stuck threshold comes from configuration; a holder sees the command amount', async () => {
    mockAll({ amount_minor: 12000, currency: 'USD' }, 1440);
    wrap(<BillingReconciliationView now={() => new Date(AS_OF)} />);
    expect(await screen.findByTestId('exception-count')).toHaveTextContent('2');
    expect(screen.getByText('Missing entitlement')).toBeInTheDocument();
    expect(await screen.findByText('Amount $120')).toBeInTheDocument();
    expect(screen.getByText('Pending past the 24 h threshold')).toBeInTheDocument();
    expect(screen.getByText(/configured threshold \(24 h\)/)).toBeInTheDocument();
  });

  it('V12-RC-2 a non-holder gets WithheldAmount for the command amount; without configuration no pending command is called stuck', async () => {
    mockAll({ currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' }, null);
    wrap(<BillingReconciliationView now={() => new Date(AS_OF)} />);
    const row = await screen.findByTestId('command-cb300000-0000-7000-8000-00000000c001');
    expect(within(row).getByLabelText('Amount withheld: finance access required')).toBeInTheDocument();
    expect(screen.queryByText(/Pending past the/)).toBeNull();
    expect(screen.getByText('No inbox exceptions')).toBeInTheDocument();
  });
});

describe('Finance › Revenue (§13.5; §17.2; DV-V12-REV-1)', () => {
  const bucket = (month: string, o: Record<string, unknown>) => ({ month, commitment_end: 0, period_end: 0, events: 2, priced_events: 1, unpriced_events: 1, ...o });
  const report = (holder: boolean): RevenueReport => ({
    as_of: AS_OF, currency: 'USD', billing_interval: 'MONTH', basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE', billing_provider_mode: 'test', tax: { enabled: false },
    ...(holder ? { mrr_minor: 40000, arr_minor: 480000 } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' as const }),
    by_product: [],
    counts: { open_commercial_subscriptions: 5, included: 3, excluded: 2, excluded_by_reason: { CONTRACT_PRICED: 1, STATUS_NOT_REVENUE_BEARING: 1 }, not_commercial_by_source: {} },
    renewal_pipeline: { months: 6, from_month: '2026-10', through_month: '2027-03', lapsed: bucket('LAPSED', {}), by_month: [bucket('2026-10', holder ? { mrr_minor: 2400 } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }), bucket('2026-11', { events: 1, priced_events: 0, unpriced_events: 1, ...(holder ? { mrr_minor: 0 } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }) })] },
  });

  it('V12-RV-1 a holder sees the list-price values, never labelled MRR / ARR / revenue, with the note', async () => {
    vi.spyOn(financeApi, 'revenue').mockResolvedValue(report(true));
    wrap(<RevenueView session={sessionFor('finance_admin')} />);
    expect(await screen.findByTestId('revenue-mrr')).toHaveTextContent(`${MONTHLY_LABEL}$400`);
    expect(screen.getByTestId('revenue-arr')).toHaveTextContent(`${ANNUAL_LABEL}$4,800`);
    expect(screen.getByTestId('revenue-list-price-note')).toHaveTextContent(LIST_PRICE_NOTE);
    expect(screen.queryByText(/^MRR$|^ARR$/)).toBeNull();
    expect(screen.getByText('$24 / month')).toBeInTheDocument();
    expect(screen.getByText(/Bar length shows list value\./)).toBeInTheDocument();
    // Withheld tile: excluded rows other than by status.
    expect(screen.getByText('1 contract-priced')).toBeInTheDocument();
  });

  it('V12-RV-2 a non-holder: page note, WithheldAmount (stat) on both values and (cell) per month, bars by count', async () => {
    vi.spyOn(financeApi, 'revenue').mockResolvedValue(report(false));
    wrap(<RevenueView session={sessionFor('commercial_ops')} />);
    expect(await screen.findByText(/Counts stay visible; every figure is withheld\./)).toBeInTheDocument();
    expect(within(screen.getByTestId('revenue-mrr')).getByLabelText('Amount withheld: finance access required')).toBeInTheDocument();
    expect(within(screen.getByTestId('revenue-month-2026-10')).getByLabelText('Amount withheld: finance access required')).toBeInTheDocument();
    expect(screen.getByText(/Bar length shows the number of renewals\./)).toBeInTheDocument();
    expect(screen.getByText('Included').nextSibling).toHaveTextContent('3');
  });
});

describe('Usage › Consumption (§13.4)', () => {
  const recon = (status: UsageReconciliation['status'], o: Partial<UsageReconciliation['metrics'][number]> = {}): UsageReconciliation => ({
    product_key: 'sign', status, checked_at: AS_OF,
    metrics: [{ metric_key: 'sign.envelopes', product_key: 'sign', status, watermark: '2026-10-24T12:00:00.000Z', last_run_id: 'r1', buckets: { source: 1, rollup: 1, pending: 0, compared: 1, mismatched: 0 }, mismatch_count: status === 'NOT_RECONCILED' ? 3 : 0, ...o }],
  });
  const period = (tenant: string, start: string, o: Partial<UsagePeriod> = {}): UsagePeriod => ({
    tenant_id: tenant, metric_key: 'sign.envelopes', product_key: 'sign', period_start: start, period_end: null, alignment: 'ALIGNED', subscription_id: null, plan_version_id: null, included_quantity: 25000, unlimited: false,
    counts: { consumed: 18240, consumed_send: 18240, consumed_historical: 0, reserved: 120 }, stale: false, computed_at: AS_OF, ...o,
  });

  it('V12-US-1 reconciled: the banner and the table, sorted by tenant then period (never by volume)', async () => {
    vi.spyOn(usageApi, 'reconciliation').mockResolvedValue(recon('RECONCILED'));
    vi.spyOn(usageApi, 'periods').mockResolvedValue({ product_key: 'sign', reconciliation: { status: 'RECONCILED', checked_at: AS_OF }, truncated: false, periods: [period(T2, '2026-09-22T00:00:00.000Z', { counts: { consumed: 96, consumed_send: 96, consumed_historical: 0, reserved: 0 } }), period(T1, '2026-09-08T00:00:00.000Z', { alignment: 'UNALIGNED' }), period(T1, '2026-10-08T00:00:00.000Z')] });
    wrap(<ConsumptionView />);
    expect(await screen.findByTestId('usage-recon-banner')).toHaveTextContent('Reconciled. Roll-ups match Sign records. Last run 2026-10-24 12:00 UTC.');
    await screen.findAllByText('18,240');
    await waitFor(() => expect(screen.getAllByRole('row')[1]).toHaveTextContent('Fernhill Studio'));
    const rows = screen.getAllByRole('row').slice(1);
    // By tenant name, then period newest first; the 96-envelope tenant still sorts first.
    expect(rows.map((r) => r.textContent?.slice(0, 30))).toEqual([expect.stringMatching(/^Fernhill StudioSeptember/), expect.stringMatching(/^Halcyon HealthOctober/), expect.stringMatching(/^Halcyon HealthSeptember/)]);
    expect(screen.getByText('Unaligned')).toBeInTheDocument();
  });

  it('V12-US-2 not reconciled: the periods read is not made and the refused card replaces the table', async () => {
    vi.spyOn(usageApi, 'reconciliation').mockResolvedValue(recon('NOT_RECONCILED'));
    const periods = vi.spyOn(usageApi, 'periods');
    wrap(<ConsumptionView />);
    expect(await screen.findByTestId('usage-recon-banner')).toHaveTextContent('Not reconciled · 3 mismatches.');
    expect(screen.getByTestId('usage-recon-banner')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('usage-refused')).toHaveTextContent('409 USAGE_ROLLUP_NOT_RECONCILED');
    expect(screen.getByRole('link', { name: 'See the open alert →' })).toHaveAttribute('href', '/commercial/alerts');
    expect(screen.queryByRole('table')).toBeNull();
    expect(periods).not.toHaveBeenCalled();
  });

  it('V12-US-3 the server’s own 409 on the periods read renders the same refused state', async () => {
    vi.spyOn(usageApi, 'reconciliation').mockResolvedValue(recon('RECONCILED', { buckets: { source: 1, rollup: 1, pending: 2, compared: 1, mismatched: 0 } }));
    vi.spyOn(usageApi, 'periods').mockRejectedValue(new ApiError(409, 'nr', 'USAGE_ROLLUP_NOT_RECONCILED'));
    wrap(<ConsumptionView />);
    expect(await screen.findByTestId('usage-refused')).toBeInTheDocument();
  });
});

describe('Operations › Alerts (§13.6; D-2)', () => {
  const alert = (o: Partial<CommercialAlert>): CommercialAlert => ({
    id: 'cb300000-0000-7000-8000-00000000a001', alert_type: 'COMMAND_FAILED', family: 'BILLING', subject_kind: 'billing_command', subject_id: 'cb300000-0000-7000-8000-00000000c001', tenant_id: T1, product_key: 'sign', status: 'OPEN',
    detail: 'CREDIT_GRANT FAILED PROVIDER_REFUSED after 3 attempt(s)', evidence: { command_kind: 'CREDIT_GRANT', change_request_id: null }, threshold_minutes: null, detection_count: 1, first_detected_at: '2026-10-22T10:00:00.000Z', last_detected_at: AS_OF, resolved_at: null, resolution_detail: null, ...o,
  });

  it('V12-AL-1 both families merged newest first; Open by default; resolved rows say what they became; no actions', async () => {
    vi.spyOn(alertsApi, 'billing').mockResolvedValue({ alerts: [alert({})], next_cursor: null });
    vi.spyOn(alertsApi, 'approvals').mockResolvedValue({
      alerts: [alert({ id: 'cb300000-0000-7000-8000-00000000a002', alert_type: 'APPLY_DEADLINE_NEARING', family: 'APPROVAL', subject_kind: 'change_request', subject_id: 'cb300000-0000-7000-8000-000000001054', evidence: { action_type: 'ENTITLEMENT_GRANT' }, first_detected_at: '2026-10-24T10:00:00.000Z' }), alert({ id: 'cb300000-0000-7000-8000-00000000a003', alert_type: 'APPROVAL_PAST_EXPIRY', family: 'APPROVAL', subject_kind: 'change_request', status: 'RESOLVED', resolution_detail: 'request expired' })],
      next_cursor: null,
    });
    wrap(<AlertsView />);
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Approved request near its apply deadline');
    expect(rows[0]).toHaveTextContent('Action needed');
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/commercial/approvals?request=cb300000-0000-7000-8000-000000001054');
    expect(rows[1]).toHaveTextContent('Stripe command failed');
    expect(screen.getByRole('button', { name: /^Open/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Resolved/ }));
    expect(screen.getByText('Became: request expired')).toBeInTheDocument();
    expect(screen.getByText('Resolved automatically')).toBeInTheDocument();
    // No acknowledge / retry / resolve: the only buttons are the three filters.
    expect(screen.getAllByRole('button').map((b) => b.textContent?.replace(/\d+$/, ''))).toEqual(['Open', 'Resolved', 'All']);
    expect(screen.getByText(ALERTS_FOOT)).toBeInTheDocument();
  });

  it('V12-AL-2 empty filters', async () => {
    vi.spyOn(alertsApi, 'billing').mockResolvedValue({ alerts: [], next_cursor: null });
    vi.spyOn(alertsApi, 'approvals').mockResolvedValue({ alerts: [], next_cursor: null });
    wrap(<AlertsView />);
    expect(await screen.findByText('No open alerts')).toBeInTheDocument();
  });
});
