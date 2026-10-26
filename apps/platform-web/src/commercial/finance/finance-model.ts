// CCP-UI-V12 — the pure model behind Finance › Renewals, Outstanding payments, Billing
// reconciliation and Revenue (CCP-UI v1.1 handoff §13.1–§13.3, §13.5; v1.2 §17.2). Copy follows
// the pinned Commercial Control Plane v1.2.dc.html; every value comes from the C6 / C1 / D2 reads.
// Money is shown only as the server sent it (CCP-A1 Amendment A1): a withheld figure is never
// reconstructed, and no total is computed here (the reconciliation count is the server's).

import type { PlatformTone, WithheldPriceReason } from '../../components';
import { dayLabel, relLabel, shortRef, stampLabel } from '../support-extensions/support-extension-model';
import type { WorkbenchRow } from '../subscriptions/subscriptions-api';

import type { BillingCommand, HeldActivation, OutstandingItem, PriceFigure, ReconciledSubscription, RenewalItem, RevenueBucket, WebhookInboxEvent } from './finance-api';

export { dayLabel, relLabel, shortRef, stampLabel };

const H = 3_600_000;
const D = 24 * H;

// ── shared ────────────────────────────────────────────────────────────────────

export const PRODUCT_NAME: Readonly<Record<string, string>> = { sign: 'Aramo Sign', ats: 'ATS', portal: 'Portal', intelligence: 'Intelligence' };
export function productName(key: string | null): string {
  if (key === null) return '—';
  return PRODUCT_NAME[key] ?? key;
}

/** "$350" · "$350.50" (the design's `money`). */
export function usd(amountMinor: number): string {
  return `$${(amountMinor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** The workbench row of a subscription (tenant slug, plan name, contract reference), when listed. */
export type WorkbenchIndex = ReadonlyMap<string, WorkbenchRow>;
export function indexWorkbench(rows: readonly WorkbenchRow[]): WorkbenchIndex {
  return new Map(rows.map((r) => [r.subscription_id, r]));
}

/** "Starter" from the workbench, else the plan key in title case. */
export function planName(planKey: string, w: WorkbenchRow | undefined): string {
  if (w !== undefined) return w.plan.name;
  return planKey.length === 0 ? planKey : planKey.charAt(0).toUpperCase() + planKey.slice(1);
}

/** "Sign Team · v2" (design `plan`). */
export function planVersion(product: string, plan: string, version: number): string {
  const p = product === 'sign' ? 'Sign' : productName(product);
  return `${p} ${plan} · v${version}`;
}

export interface SourceBadge {
  readonly label: string;
  readonly stripe: boolean;
}

/** "Self-service (Stripe)" · "Manual · contract CT-2024-007" (design `srcB`). */
export function sourceBadge(source: string, contractRef: string | null): SourceBadge {
  if (source === 'SELF_SERVICE') return { label: 'Self-service (Stripe)', stripe: true };
  if (source === 'MANUAL') return { label: contractRef !== null ? `Manual · contract ${contractRef}` : 'Manual (contract)', stripe: false };
  return { label: source.charAt(0) + source.slice(1).toLowerCase(), stripe: false };
}

/** The subscription status line (design `C.SUBST`). Suspended = past due after grace. */
export function subscriptionStatus(status: string, w: WorkbenchRow | undefined, now: Date): string {
  if (status === 'PAST_DUE') {
    const g = w?.grace_until ?? null;
    if (g !== null && Date.parse(g) <= now.getTime()) return 'Suspended';
    return 'Past due';
  }
  if (status === 'ACTIVE') return 'Active';
  if (status === 'TRIALING') return 'Trialing';
  if (status === 'INCOMPLETE') return 'Incomplete';
  if (status === 'CANCELED') return 'Ended';
  return status;
}

// ── renewals (§13.1; W-1) ─────────────────────────────────────────────────────

export const HORIZONS = [90, 30, 60, 180] as const;
export type Horizon = (typeof HORIZONS)[number];

export type PriceCell =
  | { readonly kind: 'price'; readonly text: string; readonly sub: string }
  | { readonly kind: 'withheldPrice'; readonly reason: WithheldPriceReason }
  | { readonly kind: 'withheldAmount' };

const UNPRICED: Readonly<Record<string, WithheldPriceReason>> = {
  CONTRACT_PRICED: 'contract-priced',
  NON_USD_CURRENCY: 'non-USD',
  NO_LIST_PRICE: 'price missing',
  PLAN_VERSION_INTEGRITY: 'price missing',
};

/**
 * The List price cell. W-1 (Architect ruling, 2026-10-25): a published list price is catalog
 * information, shown to EVERY billing reader (the v1.2 file withholds it for non-holders:
 * DV-V12-W1). A row the catalog cannot price keeps v1.1's WithheldPrice with its reason.
 */
export function listPriceCell(p: PriceFigure): PriceCell {
  if (p.list_price !== null) {
    const per = p.list_price.billing_interval === 'MONTH' ? ' / month' : p.list_price.billing_interval === 'YEAR' ? ' / year' : '';
    return { kind: 'price', text: `${usd(p.list_price.amount_minor)}${per}`, sub: `List price · ${p.list_price.currency}` };
  }
  return { kind: 'withheldPrice', reason: UNPRICED[p.unpriced_reason ?? ''] ?? 'price missing' };
}

export interface RenewalRow {
  readonly item: RenewalItem;
  readonly tenant: string;
  readonly slug: string;
  readonly product: string;
  readonly plan: string;
  readonly status: string;
  readonly source: SourceBadge;
  readonly end: string;
  readonly kind: string;
  readonly price: PriceCell;
}

export function renewalRows(items: readonly RenewalItem[], includeLapsed: boolean, w: WorkbenchIndex, slugOf: (tenantId: string) => string | null, now: Date): RenewalRow[] {
  return items
    .filter((i) => includeLapsed || !i.lapsed)
    .slice()
    .sort((a, b) => Date.parse(a.renewal_at) - Date.parse(b.renewal_at))
    .map((i) => {
      const wr = w.get(i.subscription_id);
      return {
        item: i,
        tenant: i.tenant_name ?? wr?.tenant.name ?? shortRef(i.tenant_id),
        slug: wr?.tenant.slug ?? slugOf(i.tenant_id) ?? '—',
        product: productName(i.product_key),
        plan: planVersion(i.product_key, i.plan_name, i.version_number),
        status: subscriptionStatus(i.status, wr, now),
        source: sourceBadge(i.source, wr?.contract?.contract_ref ?? null),
        end: dayLabel(i.renewal_at),
        kind: i.renewal_kind === 'COMMITMENT_END' ? 'Commitment end' : 'Provider period end',
        price: listPriceCell(i),
      };
    });
}

/** "6 in view · 1 lapsed" (design `rn.count`). */
export function renewalCount(rows: readonly RenewalRow[]): string {
  return `${rows.length} in view · ${rows.filter((r) => r.item.lapsed).length} lapsed`;
}

// ── outstanding payments (§13.2; §17.2) ───────────────────────────────────────

export interface OutstandingRow {
  readonly item: OutstandingItem;
  readonly tenant: string;
  readonly slug: string;
  readonly plan: string;
  readonly source: SourceBadge;
  readonly status: { readonly label: string; readonly tone: PlatformTone };
  readonly grace: string;
  readonly graceSub: string;
  /** Whether the server sent the FA-4 due booleans on this row (MBC-V12-3: not yet). */
  readonly dueKnown: boolean;
}

export function outstandingRows(items: readonly OutstandingItem[], w: WorkbenchIndex, slugOf: (tenantId: string) => string | null, now: Date): OutstandingRow[] {
  return items.map((i) => {
    const wr = w.get(i.subscription_id);
    const status =
      i.status === 'INCOMPLETE'
        ? { label: 'Incomplete', tone: 'info' as const }
        : i.grace_state === 'GRACE_ENDED'
          ? { label: 'Suspended', tone: 'danger' as const }
          : { label: i.grace_state === 'IN_GRACE' ? 'Past due · in grace' : 'Past due', tone: 'warn' as const };
    const g = i.grace_until;
    const grace =
      i.grace_state === 'IN_GRACE' && g !== null
        ? { grace: dayLabel(g), graceSub: `${Math.round((Date.parse(g) - now.getTime()) / D)} days left` }
        : i.grace_state === 'GRACE_ENDED' && g !== null
          ? { grace: `Ended ${dayLabel(g)}`, graceSub: `Suspended ${dayLabel(g)}` }
          : { grace: 'No grace period', graceSub: i.status === 'INCOMPLETE' ? 'Checkout held behind the Manual row (C-8)' : '' };
    return {
      item: i,
      tenant: i.tenant_name ?? wr?.tenant.name ?? shortRef(i.tenant_id),
      slug: wr?.tenant.slug ?? slugOf(i.tenant_id) ?? '—',
      plan: planVersion(i.product_key, planName(i.plan_key, wr), i.version_number),
      source: sourceBadge(i.source, wr?.contract?.contract_ref ?? null),
      status,
      ...grace,
      dueKnown: typeof i.payment_due === 'boolean' || typeof i.payment_overdue === 'boolean',
    };
  });
}

/** The amount cell for a holder: v1 never has an invoice amount (C3 not delivered). */
export const AMOUNT_NOT_YET = 'Not yet available';

// ── billing reconciliation (§13.3) ────────────────────────────────────────────

export interface MismatchRow {
  readonly key: string;
  readonly tenantId: string;
  readonly tenant: string;
  readonly product: string;
  readonly subscription: string;
  readonly version: string;
  readonly entitlement: string;
  readonly flag: string;
  readonly why: string;
}

const DISCREPANCY: Readonly<Record<string, { readonly flag: string; readonly why: string }>> = {
  ENTITLEMENT_MISSING: { flag: 'Missing entitlement', why: 'Open subscription, but the product entitlement is not active.' },
  PLAN_VERSION_INTEGRITY: { flag: 'Pinned version unreadable', why: 'The pinned plan version’s terms failed their integrity check.' },
  PLAN_VERSION_NOT_PINNABLE: { flag: 'Pinned version not published', why: 'The subscription is pinned to a version that was never published.' },
  PRICE_NOT_USD: { flag: 'Price not in USD', why: 'The pinned list price is not in USD.' },
  SELF_SERVICE_WITHOUT_PROVIDER_LINK: { flag: 'Self-service without Stripe link', why: 'A self-service row carries no Stripe subscription.' },
  MANUAL_PROVIDER_LINKED: { flag: 'Manual row linked to Stripe', why: 'A Manual row carries a Stripe subscription.' },
};

export function mismatchRows(
  subs: readonly ReconciledSubscription[],
  entitled: readonly { tenant_id: string; tenant_name: string | null; product_key: string; capabilities: string[]; residual_authority: string | null }[],
  now: Date,
): MismatchRow[] {
  const out: MismatchRow[] = [];
  for (const s of subs) {
    for (const code of s.discrepancies) {
      const d = DISCREPANCY[code] ?? { flag: code, why: '' };
      out.push({
        key: `${s.subscription_id}:${code}`,
        tenantId: s.tenant_id,
        tenant: s.tenant_name ?? shortRef(s.tenant_id),
        product: productName(s.product_key),
        subscription: `${s.product_key === 'sign' ? 'Sign' : productName(s.product_key)} ${planName(s.plan_key, undefined)} · ${subscriptionStatus(s.status, undefined, now)}`,
        version: `v${s.version_number} · ${s.version_status === 'RETIRED' ? 'retired (grandfathered)' : s.version_status === 'PUBLISHED' ? 'published' : s.version_status.toLowerCase()}`,
        entitlement: code === 'ENTITLEMENT_MISSING' ? 'Not active' : 'Active',
        flag: d.flag,
        why: d.why,
      });
    }
  }
  for (const e of entitled) {
    out.push({
      key: `${e.tenant_id}:${e.product_key}:ent`,
      tenantId: e.tenant_id,
      tenant: e.tenant_name ?? shortRef(e.tenant_id),
      product: productName(e.product_key),
      subscription: 'No open subscription',
      version: '—',
      entitlement: 'Active',
      flag: 'Entitlement without subscription',
      why: e.residual_authority === 'GRACE' ? 'No open subscription; access continues while grace lasts.' : e.residual_authority === 'SUPPORT_OVERLAY' ? 'No open subscription; access continues under a support extension.' : 'No open subscription, but the entitlement is still active.',
    });
  }
  return out;
}

export interface HeldRow {
  readonly key: string;
  readonly tenantId: string;
  readonly tenant: string;
  readonly manual: string;
  readonly attempt: string;
  readonly at: string;
  readonly plan: string;
  readonly cmd: string;
  readonly cmdSub: string;
  readonly crId: string | null;
}

export function heldRows(held: readonly HeldActivation[], w: WorkbenchIndex): HeldRow[] {
  return held.map((h) => {
    const g = h.governed_subscription_id !== null ? w.get(h.governed_subscription_id) : undefined;
    const c = h.unconfirmed_commands[0];
    const contract = g?.contract?.contract_ref ?? null;
    return {
      key: h.flag_id,
      tenantId: h.tenant_id,
      tenant: h.tenant_name ?? shortRef(h.tenant_id),
      manual: `${contract !== null ? `${contract} · ` : ''}Sign ${planName(h.governed_plan_key ?? '', g)}${g !== undefined ? ` v${g.plan_version.version_number}` : ''} · Manual`,
      attempt: `Self-service checkout ${h.subscription_ref} · ${(h.intent_status ?? 'incomplete').toLowerCase()}`,
      at: stampLabel(h.detected_at),
      plan: h.held_plan_key !== null ? `Sign ${planName(h.held_plan_key, undefined)}` : '—',
      cmd: c === undefined ? 'No release requested' : c.state === 'CONFIRMED' ? 'Confirmed' : 'Sent to Stripe — awaiting confirmation',
      cmdSub: c === undefined ? '' : shortRef(c.id),
      crId: c?.change_request_id ?? null,
    };
  });
}

/** Stripe command kinds → the design's plain labels. */
const COMMAND_KIND: Readonly<Record<string, string>> = {
  SUBSCRIPTION_CANCEL: 'Cancel subscription',
  CHECKOUT_SESSION_EXPIRE: 'Expire checkout session',
  CREDIT_GRANT: 'Apply account credit',
  CREDIT_REVERSE: 'Reverse account credit',
  DISCOUNT_APPLY: 'Apply discount',
  DISCOUNT_REMOVE: 'Remove discount',
  REFUND_CREATE: 'Create refund',
};

export function commandKindLabel(kind: string): string {
  return COMMAND_KIND[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, ' ');
}

export interface CommandRow {
  readonly cmd: BillingCommand;
  readonly id: string;
  readonly kind: string;
  readonly state: { readonly label: string; readonly tone: PlatformTone };
  readonly at: string;
  readonly age: string;
  readonly detail: string;
  /** The amount is present (holder) / withheld (non-holder) / not a monetary command. */
  readonly amount: { readonly kind: 'shown'; readonly text: string } | { readonly kind: 'withheld' } | null;
}

/** The amount on a command's params, as the server sent it (R3 omits it for non-holders). */
export function commandAmount(params: Record<string, unknown>): CommandRow['amount'] {
  if (typeof params['amount_withheld'] === 'string') return { kind: 'withheld' };
  const a = params['amount_minor'];
  if (typeof a === 'number' && Number.isFinite(a)) return { kind: 'shown', text: `Amount ${usd(a)}` };
  return null;
}

/**
 * The Commands exceptions: every FAILED command, and every command pending at the provider for at
 * least the configured threshold (TD-D3-2: 24 h; the value is read from configuration). Newest first.
 */
export function commandRows(failed: readonly BillingCommand[], pending: readonly BillingCommand[], stuckMinutes: number, now: Date): CommandRow[] {
  const stuck = pending.filter((c) => now.getTime() - Date.parse(c.provider_accepted_at ?? c.created_at) >= stuckMinutes * 60_000);
  const hours = Math.round(stuckMinutes / 60);
  return [...failed, ...stuck]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((c) => ({
      cmd: c,
      id: c.id,
      kind: commandKindLabel(c.command_kind),
      state: c.state === 'FAILED' ? { label: 'Failed', tone: 'danger' as const } : { label: 'Stuck pending', tone: 'warn' as const },
      at: stampLabel(c.provider_accepted_at ?? c.created_at),
      age: relLabel(c.provider_accepted_at ?? c.created_at, now),
      detail: c.state === 'FAILED' ? (c.failure?.code ?? 'Failed') : `Pending past the ${hours} h threshold`,
      amount: commandAmount(c.params),
    }));
}

export interface InboxRow {
  readonly ev: WebhookInboxEvent;
  readonly state: { readonly label: string; readonly tone: PlatformTone };
  readonly at: string;
  readonly attempts: string;
  readonly detail: string;
}

/** Failed inbox events, and events stalled in PROCESSING (oldest stall first after failures). */
export function inboxRows(failed: readonly WebhookInboxEvent[], processing: readonly WebhookInboxEvent[]): InboxRow[] {
  return [...failed, ...processing].map((e) => ({
    ev: e,
    state: e.status === 'FAILED' ? { label: 'Failed', tone: 'danger' as const } : { label: 'Stuck processing', tone: 'warn' as const },
    at: stampLabel(e.received_at),
    attempts: `${e.attempts} ${e.attempts === 1 ? 'attempt' : 'attempts'}`,
    detail: e.last_error ?? e.detail ?? '',
  }));
}

// ── revenue (§13.5; §17.2) ────────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 2026" from "2026-10". */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MON[Number(m) - 1] ?? m} ${y}`;
}

export const EXCLUSION_LABEL: Readonly<Record<string, string>> = {
  CONTRACT_PRICED: 'contract-priced',
  NON_USD_CURRENCY: 'non-USD',
  NO_LIST_PRICE: 'price missing',
  PLAN_VERSION_INTEGRITY: 'price missing',
  NON_MONTHLY_INTERVAL: 'not monthly',
};

/**
 * The Withheld tile (design `rv.whN`): open active or past-due subscriptions with no USD monthly
 * list price. A row excluded only for its status (suspended, trialing…) is not "withheld".
 */
export function withheldCount(byReason: Readonly<Record<string, number>>): number {
  return Object.entries(byReason).reduce((a, [k, n]) => (k === 'STATUS_NOT_REVENUE_BEARING' ? a : a + n), 0);
}

/** The Withheld tile's line: the exclusion reasons with their counts (no per-tenant row, D2). */
export function withheldLine(byReason: Readonly<Record<string, number>>): string {
  const parts = Object.entries(byReason)
    .filter(([k, n]) => n > 0 && k !== 'STATUS_NOT_REVENUE_BEARING')
    .map(([k, n]) => `${n} ${EXCLUSION_LABEL[k] ?? k.toLowerCase().replace(/_/g, ' ')}`);
  return parts.length > 0 ? parts.join(', ') : 'None';
}

export interface MonthRow {
  readonly month: string;
  readonly label: string;
  readonly count: string;
  readonly value: { readonly kind: 'shown'; readonly text: string } | { readonly kind: 'withheld' } | { readonly kind: 'none' };
  readonly withheldNote: string;
  /** Bar length in percent (value for a holder; renewal count for a non-holder). */
  readonly bar: number;
}

/** Renewals by month (design `rv.months`): bars by list value, or by count when amounts are withheld. */
export function monthRows(buckets: readonly RevenueBucket[], amounts: boolean): MonthRow[] {
  const maxV = Math.max(1, ...buckets.map((b) => b.mrr_minor ?? 0));
  const maxN = Math.max(1, ...buckets.map((b) => b.events));
  return buckets.map((b) => {
    const v = b.mrr_minor ?? 0;
    const value: MonthRow['value'] = b.amount_withheld !== undefined ? (b.priced_events > 0 ? { kind: 'withheld' } : { kind: 'none' }) : v > 0 ? { kind: 'shown', text: `${usd(v)} / month` } : { kind: 'none' };
    return {
      month: b.month,
      label: monthLabel(b.month),
      count: `${b.events} ${b.events === 1 ? 'renewal' : 'renewals'}`,
      value,
      withheldNote: b.unpriced_events > 0 ? `${b.unpriced_events} withheld` : '',
      bar: Math.round(amounts ? (v / maxV) * 100 : (b.events / maxN) * 100),
    };
  });
}

/** Hours from minutes (configuration thresholds are minutes; labels read hours). */
export function hoursOf(minutes: number): number {
  return Math.round(minutes / 60);
}

export { H as HOUR_MS };
