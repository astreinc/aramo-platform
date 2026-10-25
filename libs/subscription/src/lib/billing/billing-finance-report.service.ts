import { Inject, Injectable } from '@nestjs/common';

import { planVersionTerms, type PlanVersionContent } from '../plan-version.js';
import { PRODUCT_CAPABILITIES, assertProductKey, isProductKey, type ProductKey } from '../product-registry.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { BILLING_PROVIDER_PORT, type BillingProviderPort } from './billing-provider.port.js';
import { GOVERNED_SUBSCRIPTION_OPEN } from './governed-subscription.js';

// CCP-C6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C6; Conversion Rule C-8;
// PLATFORM-UX-1 Amendment A1-4a) — the READ-ONLY Finance reports: the renewals queue, outstanding
// payments, and the billing reconciliation report (including held activations).
//
// Every figure is derived from commercial records, never invented (the C6 HALT rule):
//   - subscriptions, their pinned plan versions (checksum-verified through planVersionTerms),
//     reconciliation flags, checkout intents, Stripe commands and inbox rows (libs/subscription),
//   - effective entitlements (entitlement."TenantEntitlement"; revoked rows excluded when the
//     column exists).
// The ONLY monetary figure is a plan version's list price per billing interval, in USD minor
// units. No amount owed, invoice total, proration, discount or sum is computed: invoice and
// payment status is CCP-C3 (NOT DELIVERED), so amount_due is null with a stated reason; a
// non-USD or missing price is never shown (unpriced_reason). Revenue aggregates are CCP-D2.
//
// Each report runs in ONE REPEATABLE READ transaction opened READ ONLY: a consistent snapshot,
// and any write would raise. Nothing here calls the billing provider.

export const FINANCE_CURRENCY = 'USD' as const;
export const RENEWAL_HORIZON_DEFAULT_DAYS = 90;
export const RENEWAL_HORIZON_MAX_DAYS = 365;
/** Sources that carry a commercial renewal or payment (FREE and DEVELOPMENT do not). */
export const FINANCE_SOURCES = ['MANUAL', 'SELF_SERVICE'] as const;
export const OUTSTANDING_STATUSES = ['PAST_DUE', 'INCOMPLETE'] as const;
export const INVOICE_READ_NOT_DELIVERED = 'INVOICE_READ_NOT_DELIVERED';

export type UnpricedReason = 'CONTRACT_PRICED' | 'NO_LIST_PRICE' | 'NON_USD_CURRENCY' | 'PLAN_VERSION_INTEGRITY';

export interface ListPrice {
  readonly amount_minor: number;
  readonly currency: typeof FINANCE_CURRENCY;
  readonly billing_interval: string | null;
}

export interface PriceFigure {
  /** null when not derivable from the version (see unpriced_reason). */
  readonly list_price: ListPrice | null;
  readonly unpriced_reason: UnpricedReason | null;
  /** Where the figure comes from (always a plan version row). */
  readonly price_source: 'PINNED_PLAN_VERSION' | 'CURRENT_PUBLISHED_PLAN_VERSION';
  readonly plan_version_id: string | null;
}

export type RenewalKind = 'COMMITMENT_END' | 'PERIOD_END';

export interface RenewalItem extends PriceFigure {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly plan_name: string;
  readonly version_number: number;
  readonly grandfathered: boolean;
  readonly renewal_kind: RenewalKind;
  readonly renewal_at: Date;
  /** Whole days from as_of to renewal_at (rounded up; negative or 0 when lapsed). */
  readonly days_until: number;
  readonly lapsed: boolean;
  readonly commitment_months: number | null;
  readonly cancel_at_period_end: boolean;
  readonly cancel_requested_within_commitment: boolean;
}

export interface RenewalsReport {
  readonly as_of: Date;
  readonly within_days: number;
  readonly currency: typeof FINANCE_CURRENCY;
  readonly billing_provider_mode: 'test' | 'live' | 'unconfigured';
  readonly items: RenewalItem[];
  readonly counts: { readonly items: number; readonly lapsed: number; readonly commitment_end: number; readonly period_end: number };
}

export type GraceState = 'IN_GRACE' | 'GRACE_ENDED' | 'NO_GRACE_DATE';

export interface OutstandingItem extends PriceFigure {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly version_number: number;
  readonly billing_subscription_ref: string | null;
  readonly status_since: Date | null;
  readonly grace_until: Date | null;
  readonly grace_state: GraceState;
  readonly current_period_end: Date | null;
  /** Never computed here: the invoice read-through is CCP-C3 (NOT DELIVERED). */
  readonly amount_due: null;
  readonly amount_due_reason: typeof INVOICE_READ_NOT_DELIVERED;
}

export interface OutstandingReport {
  readonly as_of: Date;
  readonly currency: typeof FINANCE_CURRENCY;
  readonly billing_provider_mode: 'test' | 'live' | 'unconfigured';
  readonly items: OutstandingItem[];
  readonly counts: { readonly items: number; readonly past_due: number; readonly incomplete: number; readonly in_grace: number; readonly grace_ended: number; readonly no_grace_date: number };
}

export type DiscrepancyCode =
  | 'ENTITLEMENT_MISSING'
  | 'PLAN_VERSION_INTEGRITY'
  | 'PLAN_VERSION_NOT_PINNABLE'
  | 'PRICE_NOT_USD'
  | 'SELF_SERVICE_WITHOUT_PROVIDER_LINK'
  | 'MANUAL_PROVIDER_LINKED';

export interface ReconciledSubscription extends PriceFigure {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly version_number: number;
  readonly version_status: string;
  readonly grandfathered: boolean;
  readonly billing_subscription_ref: string | null;
  readonly provider_price_ref: string | null;
  readonly entitlement: { readonly expected: string[]; readonly present: string[]; readonly missing: string[] };
  readonly open_flag_reasons: string[];
  readonly unconfirmed_command_ids: string[];
  readonly discrepancies: DiscrepancyCode[];
}

export interface EntitledWithoutSubscription {
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly product_key: string;
  readonly capabilities: string[];
}

export interface HeldActivation {
  readonly flag_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly product_key: string | null;
  readonly provider: string;
  readonly subscription_ref: string;
  readonly detected_at: Date;
  readonly intent_id: string | null;
  readonly intent_status: string | null;
  readonly governed_subscription_id: string | null;
  readonly governed_plan_key: string | null;
  readonly held_plan_key: string | null;
  /** The held self-service plan's price, from its current PUBLISHED version (no pin exists yet). */
  readonly held_price: PriceFigure;
  readonly unconfirmed_commands: Array<{ readonly id: string; readonly command_kind: string; readonly state: string; readonly change_request_id: string | null }>;
  /** Conv. C-9: resolved only by a conversion, a governed end or a provider-confirmed end. */
  readonly resolution: 'UNRESOLVED' | 'PENDING_PROVIDER';
}

export interface OtherOpenFlag {
  readonly flag_id: string;
  readonly tenant_id: string;
  readonly reason: string;
  readonly provider: string;
  readonly subscription_ref: string;
  readonly detected_at: Date;
}

export interface ReconciliationReport {
  readonly as_of: Date;
  readonly currency: typeof FINANCE_CURRENCY;
  readonly billing_provider_mode: 'test' | 'live' | 'unconfigured';
  readonly status: 'RECONCILED' | 'EXCEPTIONS';
  readonly subscriptions: ReconciledSubscription[];
  readonly entitled_without_subscription: EntitledWithoutSubscription[];
  readonly held_activations: HeldActivation[];
  readonly other_open_flags: OtherOpenFlag[];
  readonly counts: {
    readonly open_subscriptions: number;
    readonly by_source: Record<string, number>;
    readonly by_status: Record<string, number>;
    readonly subscriptions_with_discrepancy: number;
    readonly discrepancies: Record<string, number>;
    readonly entitled_without_subscription: number;
    readonly held_activations: number;
    readonly other_open_flags: number;
    readonly unconfirmed_commands: number;
    readonly failed_commands: number;
    readonly failed_inbox_events: number;
    readonly unprocessed_inbox_events: number;
    /** Sum of the counts that make status EXCEPTIONS. */
    readonly exceptions: number;
  };
}

export interface FinanceFilter {
  readonly tenant_id?: string;
  readonly product_key?: ProductKey;
}

const DAY_MS = 86_400_000;

interface SubscriptionRow {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  product_key: string;
  source: string;
  status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  grace_until: Date | null;
  commitment_end: Date | null;
  cancel_requested_within_commitment: boolean;
  billing_subscription_ref: string | null;
  provider_state_at: Date | null;
  plan_key: string;
  plan_name: string;
  plan_version_id: string;
  version_number: number;
  version_status: string;
  content: unknown;
  content_checksum: string;
  provider_price_ref: string | null;
}

type Tx = Pick<PrismaService, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/** The verified terms of a version row, or null when the row fails its checksum or format. */
function verifiedTerms(row: { plan_version_id: string; content: unknown; content_checksum: string }): PlanVersionContent | null {
  try {
    return planVersionTerms({ id: row.plan_version_id, content: row.content, content_checksum: row.content_checksum });
  } catch {
    return null;
  }
}

/** The list price figure of a version (USD only; never converted, never invented). */
export function priceFigure(terms: PlanVersionContent | null, plan_version_id: string | null, price_source: PriceFigure['price_source']): PriceFigure {
  if (terms === null) return { list_price: null, unpriced_reason: plan_version_id === null ? 'NO_LIST_PRICE' : 'PLAN_VERSION_INTEGRITY', price_source, plan_version_id };
  const p = terms.plan;
  if (p.list_price_minor === null) {
    return { list_price: null, unpriced_reason: p.sales_model === 'CONTACT_SALES' ? 'CONTRACT_PRICED' : 'NO_LIST_PRICE', price_source, plan_version_id };
  }
  if (p.currency !== FINANCE_CURRENCY) return { list_price: null, unpriced_reason: 'NON_USD_CURRENCY', price_source, plan_version_id };
  return { list_price: { amount_minor: p.list_price_minor, currency: FINANCE_CURRENCY, billing_interval: p.billing_interval }, unpriced_reason: null, price_source, plan_version_id };
}

/** Whole days from `from` to `to`, rounded up (0 for an instant already reached today). */
export function daysUntil(from: Date, to: Date): number {
  const d = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  return d === 0 ? 0 : d;
}

export function graceStateAt(grace_until: Date | null, as_of: Date): GraceState {
  if (grace_until === null) return 'NO_GRACE_DATE';
  return grace_until.getTime() > as_of.getTime() ? 'IN_GRACE' : 'GRACE_ENDED';
}

const count = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

@Injectable()
export class BillingFinanceReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
  ) {}

  private providerMode(): 'test' | 'live' | 'unconfigured' {
    return this.billing.isConfigured() ? this.billing.mode() : 'unconfigured';
  }

  /** One consistent, provably read-only snapshot. */
  private async readOnly<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async openSubscriptions(tx: Tx, filter: FinanceFilter, extra = ''): Promise<SubscriptionRow[]> {
    const params: unknown[] = [];
    let where = `ts.ended_at IS NULL AND ts.composition_role = 'BASE'`;
    if (filter.tenant_id !== undefined) {
      params.push(filter.tenant_id);
      where += ` AND ts.tenant_id = $${params.length}::uuid`;
    }
    if (filter.product_key !== undefined) {
      params.push(assertProductKey(filter.product_key));
      where += ` AND ts.product_key = $${params.length}`;
    }
    return tx.$queryRawUnsafe<SubscriptionRow[]>(
      `SELECT ts.id::text AS subscription_id, ts.tenant_id::text AS tenant_id, t.name AS tenant_name, ts.product_key, ts.source, ts.status,
              ts.current_period_end, ts.cancel_at_period_end, ts.grace_until, ts.commitment_end, ts.cancel_requested_within_commitment,
              ts.billing_subscription_ref, ts.provider_state_at,
              p.key AS plan_key, p.name AS plan_name,
              v.id::text AS plan_version_id, v.version_number, v.status AS version_status, v.content, v.content_checksum,
              (SELECT pr.provider_price_ref FROM subscription."PlanVersionPrice" pr WHERE pr.plan_version_id = v.id AND pr.provider = 'STRIPE') AS provider_price_ref
         FROM subscription."TenantSubscription" ts
         JOIN subscription."Plan" p ON p.id = ts.plan_id
         JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
         LEFT JOIN identity."Tenant" t ON t.id = ts.tenant_id
        WHERE ${where}${extra}
        ORDER BY ts.tenant_id, ts.product_key, ts.id`,
      ...params,
    );
  }

  /** The renewals queue: commitment ends and provider period ends inside the horizon (lapsed included). */
  async renewals(opts: FinanceFilter & { within_days?: number; as_of?: Date } = {}): Promise<RenewalsReport> {
    const as_of = opts.as_of ?? new Date();
    const within_days = opts.within_days ?? RENEWAL_HORIZON_DEFAULT_DAYS;
    if (!Number.isInteger(within_days) || within_days < 1 || within_days > RENEWAL_HORIZON_MAX_DAYS) throw new RangeError(`within_days must be 1..${RENEWAL_HORIZON_MAX_DAYS}`);
    const horizon = new Date(as_of.getTime() + within_days * DAY_MS);
    const rows = await this.readOnly((tx) => this.openSubscriptions(tx, opts, ` AND ts.source IN ('MANUAL', 'SELF_SERVICE')`));
    const items: RenewalItem[] = [];
    for (const r of rows) {
      const terms = verifiedTerms(r);
      const price = priceFigure(terms, r.plan_version_id, 'PINNED_PLAN_VERSION');
      const base = {
        subscription_id: r.subscription_id,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        product_key: r.product_key,
        source: r.source,
        status: r.status,
        plan_key: r.plan_key,
        plan_name: r.plan_name,
        version_number: r.version_number,
        grandfathered: r.version_status === 'RETIRED',
        commitment_months: terms?.plan.commitment_months ?? null,
        cancel_at_period_end: r.cancel_at_period_end,
        cancel_requested_within_commitment: r.cancel_requested_within_commitment,
        ...price,
      };
      const due: Array<[RenewalKind, Date | null]> = [
        ['COMMITMENT_END', r.commitment_end],
        ['PERIOD_END', r.billing_subscription_ref === null ? null : r.current_period_end],
      ];
      for (const [renewal_kind, at] of due) {
        if (at === null || at.getTime() > horizon.getTime()) continue;
        items.push({ ...base, renewal_kind, renewal_at: at, days_until: daysUntil(as_of, at), lapsed: at.getTime() <= as_of.getTime() });
      }
    }
    items.sort((a, b) => a.renewal_at.getTime() - b.renewal_at.getTime() || (a.subscription_id < b.subscription_id ? -1 : a.subscription_id > b.subscription_id ? 1 : 0) || (a.renewal_kind < b.renewal_kind ? -1 : 1));
    return {
      as_of,
      within_days,
      currency: FINANCE_CURRENCY,
      billing_provider_mode: this.providerMode(),
      items,
      counts: {
        items: items.length,
        lapsed: items.filter((i) => i.lapsed).length,
        commitment_end: items.filter((i) => i.renewal_kind === 'COMMITMENT_END').length,
        period_end: items.filter((i) => i.renewal_kind === 'PERIOD_END').length,
      },
    };
  }

  /** Outstanding payments: open commercial rows in PAST_DUE or INCOMPLETE, with their grace state. */
  async outstandingPayments(opts: FinanceFilter & { as_of?: Date } = {}): Promise<OutstandingReport> {
    const as_of = opts.as_of ?? new Date();
    const rows = await this.readOnly((tx) => this.openSubscriptions(tx, opts, ` AND ts.source IN ('MANUAL', 'SELF_SERVICE') AND ts.status IN ('PAST_DUE', 'INCOMPLETE')`));
    const items: OutstandingItem[] = rows.map((r) => ({
      subscription_id: r.subscription_id,
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      product_key: r.product_key,
      source: r.source,
      status: r.status,
      plan_key: r.plan_key,
      version_number: r.version_number,
      billing_subscription_ref: r.billing_subscription_ref,
      status_since: r.provider_state_at,
      grace_until: r.grace_until,
      grace_state: graceStateAt(r.grace_until, as_of),
      current_period_end: r.current_period_end,
      amount_due: null,
      amount_due_reason: INVOICE_READ_NOT_DELIVERED,
      ...priceFigure(verifiedTerms(r), r.plan_version_id, 'PINNED_PLAN_VERSION'),
    }));
    // Grace ending soonest first; no grace date last.
    const g = (i: OutstandingItem) => (i.grace_until === null ? Number.MAX_SAFE_INTEGER : i.grace_until.getTime());
    items.sort((a, b) => g(a) - g(b) || (a.subscription_id < b.subscription_id ? -1 : 1));
    return {
      as_of,
      currency: FINANCE_CURRENCY,
      billing_provider_mode: this.providerMode(),
      items,
      counts: {
        items: items.length,
        past_due: items.filter((i) => i.status === 'PAST_DUE').length,
        incomplete: items.filter((i) => i.status === 'INCOMPLETE').length,
        in_grace: items.filter((i) => i.grace_state === 'IN_GRACE').length,
        grace_ended: items.filter((i) => i.grace_state === 'GRACE_ENDED').length,
        no_grace_date: items.filter((i) => i.grace_state === 'NO_GRACE_DATE').length,
      },
    };
  }

  /** The billing reconciliation report (commercial records vs effective entitlements; held activations). */
  async reconciliationReport(opts: FinanceFilter & { as_of?: Date } = {}): Promise<ReconciliationReport> {
    const as_of = opts.as_of ?? new Date();
    const data = await this.readOnly(async (tx) => {
      const subs = await this.openSubscriptions(tx, opts);
      const tenantParam: unknown[] = opts.tenant_id === undefined ? [] : [opts.tenant_id];
      const byTenant = (col: string) => (opts.tenant_id === undefined ? '' : ` AND ${col} = $1::uuid`);
      const hasRevoke = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'entitlement' AND table_name = 'TenantEntitlement' AND column_name = 'revoked_at'`,
      );
      const live = (hasRevoke[0]?.n ?? 0) > 0 ? 'e.revoked_at IS NULL' : 'TRUE';
      const entitlements = await tx.$queryRawUnsafe<Array<{ tenant_id: string; tenant_name: string | null; capability: string }>>(
        `SELECT e.tenant_id::text AS tenant_id, t.name AS tenant_name, e.capability::text AS capability
           FROM entitlement."TenantEntitlement" e LEFT JOIN identity."Tenant" t ON t.id = e.tenant_id
          WHERE ${live}${byTenant('e.tenant_id')} ORDER BY e.tenant_id, e.capability`,
        ...tenantParam,
      );
      const flags = await tx.$queryRawUnsafe<
        Array<{
          flag_id: string;
          tenant_id: string;
          tenant_name: string | null;
          provider: string;
          subscription_ref: string;
          reason: string;
          detected_at: Date;
          intent_id: string | null;
          intent_status: string | null;
          held_plan_key: string | null;
          held_product_key: string | null;
          held_version_id: string | null;
          held_content: unknown;
          held_checksum: string | null;
        }>
      >(
        `SELECT f.id::text AS flag_id, f.tenant_id::text AS tenant_id, t.name AS tenant_name, f.provider, f.subscription_ref, f.reason, f.detected_at,
                f.intent_id::text AS intent_id, ci.status AS intent_status, p.key AS held_plan_key, p.product_key AS held_product_key,
                v.id::text AS held_version_id, v.content AS held_content, v.content_checksum AS held_checksum
           FROM subscription."BillingReconciliationFlag" f
           LEFT JOIN identity."Tenant" t ON t.id = f.tenant_id
           LEFT JOIN subscription."CheckoutIntent" ci ON ci.id = f.intent_id
           LEFT JOIN subscription."Plan" p ON p.id = ci.plan_id
           LEFT JOIN subscription."PlanVersion" v ON v.plan_id = p.id AND v.status = 'PUBLISHED'
          WHERE f.resolved_at IS NULL${byTenant('f.tenant_id')}
          ORDER BY f.detected_at, f.id`,
        ...tenantParam,
      );
      const commands = await tx.$queryRawUnsafe<Array<{ id: string; tenant_id: string; target_ref: string; command_kind: string; state: string; change_request_id: string | null }>>(
        `SELECT id::text AS id, tenant_id::text AS tenant_id, target_ref, command_kind, state, change_request_id::text AS change_request_id
           FROM subscription."BillingProviderCommand" WHERE state <> 'CONFIRMED'${byTenant('tenant_id')} ORDER BY created_at, id`,
        ...tenantParam,
      );
      // The inbox carries no tenant (the envelope names a provider subscription), so it is counted platform-wide.
      const inbox = await tx.$queryRawUnsafe<Array<{ failed: number; unprocessed: number }>>(
        `SELECT count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*) FILTER (WHERE status IN ('RECEIVED', 'PROCESSING'))::int AS unprocessed FROM subscription."BillingWebhookInbox"`,
      );
      return { subs, entitlements, flags, commands, inbox: inbox[0] ?? { failed: 0, unprocessed: 0 } };
    });

    const capsOf = new Map<string, Set<string>>();
    const nameOf = new Map<string, string | null>();
    for (const e of data.entitlements) {
      const s = capsOf.get(e.tenant_id) ?? new Set<string>();
      s.add(e.capability);
      capsOf.set(e.tenant_id, s);
      nameOf.set(e.tenant_id, e.tenant_name);
    }
    const flagsOf = new Map<string, string[]>();
    for (const f of data.flags) flagsOf.set(f.tenant_id, [...(flagsOf.get(f.tenant_id) ?? []), f.reason]);

    const subscriptions: ReconciledSubscription[] = data.subs.map((r) => {
      const terms = verifiedTerms(r);
      const price = priceFigure(terms, r.plan_version_id, 'PINNED_PLAN_VERSION');
      const expected = isProductKey(r.product_key) ? [...PRODUCT_CAPABILITIES[r.product_key]].sort() : [];
      const have = capsOf.get(r.tenant_id) ?? new Set<string>();
      const present = expected.filter((c) => have.has(c));
      const missing = expected.filter((c) => !have.has(c));
      const discrepancies: DiscrepancyCode[] = [];
      if (missing.length > 0) discrepancies.push('ENTITLEMENT_MISSING');
      if (terms === null) discrepancies.push('PLAN_VERSION_INTEGRITY');
      if (r.version_status !== 'PUBLISHED' && r.version_status !== 'RETIRED') discrepancies.push('PLAN_VERSION_NOT_PINNABLE');
      if (price.unpriced_reason === 'NON_USD_CURRENCY') discrepancies.push('PRICE_NOT_USD');
      if (r.source === 'SELF_SERVICE' && r.billing_subscription_ref === null) discrepancies.push('SELF_SERVICE_WITHOUT_PROVIDER_LINK');
      if (r.source === 'MANUAL' && r.billing_subscription_ref !== null) discrepancies.push('MANUAL_PROVIDER_LINKED');
      return {
        subscription_id: r.subscription_id,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        product_key: r.product_key,
        source: r.source,
        status: r.status,
        plan_key: r.plan_key,
        version_number: r.version_number,
        version_status: r.version_status,
        grandfathered: r.version_status === 'RETIRED',
        billing_subscription_ref: r.billing_subscription_ref,
        provider_price_ref: r.provider_price_ref,
        entitlement: { expected, present, missing },
        open_flag_reasons: [...(flagsOf.get(r.tenant_id) ?? [])].sort(),
        unconfirmed_command_ids: data.commands.filter((c) => c.tenant_id === r.tenant_id).map((c) => c.id),
        discrepancies,
        ...price,
      };
    });

    // Product capabilities held with no open subscription of that product ('core' is shared, never product-specific).
    const entitled_without_subscription: EntitledWithoutSubscription[] = [];
    const products = opts.product_key === undefined ? (Object.keys(PRODUCT_CAPABILITIES) as ProductKey[]) : [opts.product_key];
    for (const [tenant_id, caps] of capsOf) {
      for (const product_key of products) {
        const specific = PRODUCT_CAPABILITIES[product_key].filter((c) => c !== 'core' && caps.has(c));
        if (specific.length === 0) continue;
        if (subscriptions.some((s) => s.tenant_id === tenant_id && s.product_key === product_key)) continue;
        entitled_without_subscription.push({ tenant_id, tenant_name: nameOf.get(tenant_id) ?? null, product_key, capabilities: [...specific].sort() });
      }
    }
    entitled_without_subscription.sort((a, b) => (a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : 0));

    const held_activations: HeldActivation[] = [];
    const other_open_flags: OtherOpenFlag[] = [];
    for (const f of data.flags) {
      if (f.reason !== GOVERNED_SUBSCRIPTION_OPEN) {
        other_open_flags.push({ flag_id: f.flag_id, tenant_id: f.tenant_id, reason: f.reason, provider: f.provider, subscription_ref: f.subscription_ref, detected_at: f.detected_at });
        continue;
      }
      if (opts.product_key !== undefined && f.held_product_key !== null && f.held_product_key !== opts.product_key) continue;
      const governed = data.subs.find((s) => s.tenant_id === f.tenant_id && s.source === 'MANUAL' && (f.held_product_key === null || s.product_key === f.held_product_key));
      const heldTerms = f.held_version_id === null || f.held_checksum === null ? null : verifiedTerms({ plan_version_id: f.held_version_id, content: f.held_content, content_checksum: f.held_checksum });
      const unconfirmed = data.commands
        .filter((c) => c.tenant_id === f.tenant_id && c.target_ref === f.subscription_ref)
        .map((c) => ({ id: c.id, command_kind: c.command_kind, state: c.state, change_request_id: c.change_request_id }));
      held_activations.push({
        flag_id: f.flag_id,
        tenant_id: f.tenant_id,
        tenant_name: f.tenant_name,
        product_key: f.held_product_key,
        provider: f.provider,
        subscription_ref: f.subscription_ref,
        detected_at: f.detected_at,
        intent_id: f.intent_id,
        intent_status: f.intent_status,
        governed_subscription_id: governed?.subscription_id ?? null,
        governed_plan_key: governed?.plan_key ?? null,
        held_plan_key: f.held_plan_key,
        held_price: priceFigure(heldTerms, f.held_version_id, 'CURRENT_PUBLISHED_PLAN_VERSION'),
        unconfirmed_commands: unconfirmed,
        resolution: unconfirmed.some((c) => c.state === 'PENDING_PROVIDER') ? 'PENDING_PROVIDER' : 'UNRESOLVED',
      });
    }

    const withDiscrepancy = subscriptions.filter((s) => s.discrepancies.length > 0).length;
    const failed_commands = data.commands.filter((c) => c.state === 'FAILED').length;
    const exceptions = withDiscrepancy + entitled_without_subscription.length + held_activations.length + other_open_flags.length + failed_commands + data.inbox.failed;
    return {
      as_of,
      currency: FINANCE_CURRENCY,
      billing_provider_mode: this.providerMode(),
      status: exceptions === 0 ? 'RECONCILED' : 'EXCEPTIONS',
      subscriptions,
      entitled_without_subscription,
      held_activations,
      other_open_flags,
      counts: {
        open_subscriptions: subscriptions.length,
        by_source: count(subscriptions, (s) => s.source),
        by_status: count(subscriptions, (s) => s.status),
        subscriptions_with_discrepancy: withDiscrepancy,
        discrepancies: count(subscriptions.flatMap((s) => s.discrepancies), (d) => d),
        entitled_without_subscription: entitled_without_subscription.length,
        held_activations: held_activations.length,
        other_open_flags: other_open_flags.length,
        unconfirmed_commands: data.commands.length,
        failed_commands,
        failed_inbox_events: data.inbox.failed,
        unprocessed_inbox_events: data.inbox.unprocessed,
        exceptions,
      },
    };
  }
}

const money = (p: PriceFigure): string => (p.list_price === null ? `unpriced(${p.unpriced_reason ?? 'n/a'})` : `USD ${(p.list_price.amount_minor / 100).toFixed(2)}/${p.list_price.billing_interval ?? 'interval'}`);

/** The reconciliation output as stable text lines (acceptance evidence; the D5 runbook dry-run). */
export function formatReconciliationReport(r: ReconciliationReport): string[] {
  const c = r.counts;
  const out: string[] = [
    `[reconciliation] as_of=${r.as_of.toISOString()} provider_mode=${r.billing_provider_mode} currency=${r.currency} status=${r.status} exceptions=${c.exceptions}`,
    `[reconciliation] open subscriptions: ${c.open_subscriptions} by_source=${JSON.stringify(c.by_source)} by_status=${JSON.stringify(c.by_status)}`,
    `[reconciliation] with discrepancy: ${c.subscriptions_with_discrepancy} ${JSON.stringify(c.discrepancies)}`,
  ];
  for (const s of r.subscriptions) {
    out.push(
      `[reconciliation]   sub=${s.subscription_id} tenant=${s.tenant_id} ${s.product_key} ${s.source} ${s.status} plan=${s.plan_key} v${s.version_number}${s.grandfathered ? ' grandfathered' : ''} price=${money(s)} entitlement=${s.entitlement.present.join('+') || '-'}${s.entitlement.missing.length > 0 ? ` missing=${s.entitlement.missing.join('+')}` : ''}${s.open_flag_reasons.length > 0 ? ` flags=${s.open_flag_reasons.join(',')}` : ''} discrepancies=${s.discrepancies.join(',') || 'none'}`,
    );
  }
  out.push(`[reconciliation] entitled without subscription: ${c.entitled_without_subscription}`);
  for (const e of r.entitled_without_subscription) out.push(`[reconciliation]   tenant=${e.tenant_id} ${e.product_key} capabilities=${e.capabilities.join('+')}`);
  out.push(`[reconciliation] held activations (Conv. C-8): ${c.held_activations}`);
  for (const h of r.held_activations) {
    out.push(
      `[reconciliation]   flag=${h.flag_id} tenant=${h.tenant_id} ${h.product_key ?? '?'} provider_sub=${h.subscription_ref} intent=${h.intent_id ?? '-'} (${h.intent_status ?? '-'}) governed=${h.governed_subscription_id ?? '-'} (${h.governed_plan_key ?? '-'}) held_plan=${h.held_plan_key ?? '-'} held_price=${money(h.held_price)} commands=${h.unconfirmed_commands.length} resolution=${h.resolution}`,
    );
  }
  out.push(`[reconciliation] other open flags: ${c.other_open_flags}`);
  for (const f of r.other_open_flags) out.push(`[reconciliation]   flag=${f.flag_id} tenant=${f.tenant_id} reason=${f.reason} provider_sub=${f.subscription_ref}`);
  out.push(`[reconciliation] commands: unconfirmed=${c.unconfirmed_commands} failed=${c.failed_commands}; inbox: failed=${c.failed_inbox_events} unprocessed=${c.unprocessed_inbox_events}`);
  return out;
}
