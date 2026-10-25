import { ApiError } from '@aramo/fe-foundation';

import type { PlatformTone } from '../../components';
import { actionLabel } from '../commercial-model';
import type { Catalog } from '../catalog/catalog-api';
import { planTitle } from '../catalog/catalog-model';
import { dayLabel, relLabel, shortRef } from '../support-extensions/support-extension-model';

import { PRODUCT_LABEL, type EntitlementFacts, type HeldFlag, type OpenRequestRef, type ProductCommercial, type SubscriptionFacts, type WorkbenchRow } from './subscriptions-api';

// CCP-B3 — the pure half of the Subscriptions workbench and the Tenant › Commercial tab
// (CCP-UI v1.0 handoff §5.3, §5.9; Commercial Control Plane v1.0.dc.html `sb` :835-856 and the
// card builder `td.cards` :925-950). Real values win over the prototype's sample values: the
// server's rows are the subscription records as they are (no money: PLATFORM-UX-1 A1-4a).

const DAY_MS = 86_400_000;

export { dayLabel, relLabel, shortRef };

/** "CR-1A2B3C4D": the short, stable reference of a change request (a UUID; DV-B3-2). */
export function crRef(id: string): string {
  return `CR-${shortRef(id)}`;
}

/** The approvals drawer for a request (B1 owns the drawer; linked by query). */
export function approvalsHref(id: string): string {
  return `/commercial/approvals?request=${encodeURIComponent(id)}`;
}

export function productLabel(key: string): string {
  return PRODUCT_LABEL[key] ?? key;
}

// ── status (handoff §5.3 "Status", §5.9 "Status with its grace or suspension line") ─────────

/** The workbench status segments (handoff §5.3): "In grace" = past due with a grace date ahead. */
export type StatusSegment = 'all' | 'ACTIVE' | 'PAST_DUE' | 'GRACE' | 'SUSPENDED' | 'ENDED';

export const STATUS_SEGMENTS: readonly (readonly [StatusSegment, string])[] = [
  ['all', 'All'],
  ['ACTIVE', 'Active'],
  ['PAST_DUE', 'Past due'],
  ['GRACE', 'In grace'],
  ['SUSPENDED', 'Suspended'],
  ['ENDED', 'Ended'],
];

export interface StatusView {
  /** The segments the row counts in (an in-grace row is also Past due, as the design counts it). */
  readonly segments: readonly StatusSegment[];
  readonly label: string;
  readonly tone: PlatformTone;
  /** The grace / suspension / end line ("" when none). */
  readonly line: string;
}

/**
 * The derived status. A PAST_DUE row keeps sending until `grace_until`; after it the row is
 * suspended (sending stops), still PAST_DUE in the record: the design names that state Suspended.
 */
export function statusView(s: Pick<SubscriptionFacts, 'status' | 'ended_at' | 'grace_until'>, now: Date): StatusView {
  if (s.ended_at !== null) return { segments: ['ENDED'], label: 'Ended', tone: 'muted', line: `Ended ${dayLabel(s.ended_at)}` };
  if (s.status === 'PAST_DUE') {
    if (s.grace_until === null) return { segments: ['PAST_DUE'], label: 'Past due', tone: 'warn', line: '' };
    if (new Date(s.grace_until).getTime() > now.getTime()) {
      return { segments: ['PAST_DUE', 'GRACE'], label: 'Past due · in grace', tone: 'warn', line: `Grace ends ${dayLabel(s.grace_until)} (${relLabel(s.grace_until, now)})` };
    }
    return { segments: ['SUSPENDED'], label: 'Suspended', tone: 'danger', line: `Suspended ${dayLabel(s.grace_until)} after grace` };
  }
  if (s.status === 'ACTIVE') return { segments: ['ACTIVE'], label: 'Active', tone: 'ok', line: '' };
  if (s.status === 'TRIALING') return { segments: ['ACTIVE'], label: 'Trialing', tone: 'neutral', line: '' };
  if (s.status === 'INCOMPLETE') return { segments: [], label: 'Incomplete', tone: 'neutral', line: '' };
  if (s.status === 'CANCELED') return { segments: [], label: 'Canceled', tone: 'muted', line: '' };
  return { segments: [], label: s.status, tone: 'neutral', line: '' };
}

// ── period, commitment, version, source (handoff §5.3 columns) ───────────────────────────────

function addMonthsClamped(anchor: Date, months: number): Date {
  const m = anchor.getUTCMonth() + months;
  const y = anchor.getUTCFullYear() + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), new Date(Date.UTC(y, mm + 1, 0)).getUTCDate());
  return new Date(Date.UTC(y, mm, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/** The monthly period containing `at` (the libs/subscription billing-period rule; end exclusive). */
export function billingPeriodAt(anchorIso: string, at: Date): { start: Date; end: Date } {
  const anchor = new Date(anchorIso);
  if (at.getTime() < anchor.getTime()) return { start: anchor, end: addMonthsClamped(anchor, 1) };
  let k = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  if (addMonthsClamped(anchor, k).getTime() > at.getTime()) k -= 1;
  return { start: addMonthsClamped(anchor, k), end: addMonthsClamped(anchor, k + 1) };
}

/**
 * "8 Oct 2026 – 7 Nov 2026": the current period (the last one for an ended row), shown with its
 * inclusive last day as the design does (end exclusive in the record).
 */
export function periodText(s: Pick<SubscriptionFacts, 'current_period' | 'ended_at' | 'period_anchor'>): string {
  let start: Date;
  let end: Date;
  if (s.current_period !== null) {
    start = new Date(s.current_period.start);
    end = new Date(s.current_period.end);
  } else if (s.ended_at !== null) {
    const p = billingPeriodAt(s.period_anchor, new Date(new Date(s.ended_at).getTime() - 1));
    start = p.start;
    end = p.end;
  } else {
    return '—';
  }
  return `${dayLabel(start.toISOString())} – ${dayLabel(new Date(end.getTime() - DAY_MS).toISOString())}`;
}

/** Whole days to an instant, as the design rounds them. */
export function daysTo(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / DAY_MS);
}

export function commitmentCell(s: Pick<SubscriptionFacts, 'commitment_end' | 'source'>, now: Date): { readonly date: string; readonly rel: string } {
  if (s.commitment_end === null) return { date: '—', rel: s.source === 'SELF_SERVICE' ? 'No commitment' : '' };
  const d = daysTo(s.commitment_end, now);
  return { date: dayLabel(s.commitment_end), rel: d < 0 ? 'Ended' : `in ${d} days` };
}

export function versionText(s: Pick<SubscriptionFacts, 'plan_version'>): string {
  return `v${s.plan_version.version_number}${s.plan_version.status === 'RETIRED' ? ' · grandfathered' : ''}`;
}

export function isStripeOwned(s: Pick<SubscriptionFacts, 'source'>): boolean {
  return s.source === 'SELF_SERVICE';
}

/** Source badge (handoff §5.3): "Managed in Stripe" for self-service; "MANUAL · {contract}" for a governed row. */
export function sourceBadge(s: Pick<SubscriptionFacts, 'source' | 'contract'>, generic = false): { readonly label: string; readonly stripe: boolean } {
  if (s.source === 'SELF_SERVICE') return { label: 'Managed in Stripe', stripe: true };
  if (s.source === 'MANUAL') return { label: `MANUAL · ${generic || s.contract === null ? 'contract' : s.contract.contract_ref}`, stripe: false };
  return { label: s.source, stripe: false };
}

export interface RowFlag {
  readonly label: string;
  readonly kind: 'recon' | 'exception';
}

/** The Flags column: a reconciliation flag (held activation, Conv. C-8) and an active extension overlay. */
export function rowFlags(s: Pick<SubscriptionFacts, 'open_flags' | 'active_extensions'>): RowFlag[] {
  const out: RowFlag[] = [];
  if (s.open_flags.length > 0) out.push({ label: 'Reconciliation flag', kind: 'recon' });
  if (s.active_extensions.count > 0) out.push({ label: s.active_extensions.exception ? 'Extension · exception' : 'Extension', kind: 'exception' });
  return out;
}

// ── the workbench filters (handoff §5.3) ─────────────────────────────────────────────────────

export interface WorkbenchFilter {
  readonly status: StatusSegment;
  readonly product: string;
  readonly source: 'all' | 'MANUAL' | 'SELF_SERVICE';
  /** `${plan_version.id}` or 'all'. */
  readonly version: string;
  readonly commitment: 'any' | '30' | '60' | '90';
  readonly flagged: boolean;
}

export const NO_FILTER: WorkbenchFilter = { status: 'all', product: 'all', source: 'all', version: 'all', commitment: 'any', flagged: false };

export function passesFilter(r: WorkbenchRow, f: WorkbenchFilter, now: Date, skipStatus = false): boolean {
  if (f.product !== 'all' && r.product_key !== f.product) return false;
  if (f.source !== 'all' && r.source !== f.source) return false;
  if (f.version !== 'all' && r.plan_version.id !== f.version) return false;
  if (f.flagged && r.open_flags.length === 0) return false;
  if (f.commitment !== 'any') {
    if (r.commitment_end === null) return false;
    const ms = new Date(r.commitment_end).getTime() - now.getTime();
    if (ms < 0 || ms > Number(f.commitment) * DAY_MS) return false;
  }
  if (!skipStatus && f.status !== 'all' && !statusView(r, now).segments.includes(f.status)) return false;
  return true;
}

/** The status segments with their counts under the other filters (the design's counting). */
export function segmentCounts(rows: readonly WorkbenchRow[], f: WorkbenchFilter, now: Date): Record<StatusSegment, number> {
  const base = rows.filter((r) => passesFilter(r, f, now, true));
  const out = { all: base.length, ACTIVE: 0, PAST_DUE: 0, GRACE: 0, SUSPENDED: 0, ENDED: 0 } as Record<StatusSegment, number>;
  for (const r of base) for (const s of statusView(r, now).segments) out[s] += 1;
  return out;
}

/** "Sign Team v2" options for the Plan version filter, from the rows (distinct, by plan then version). */
export function versionOptions(rows: readonly WorkbenchRow[]): { readonly value: string; readonly label: string }[] {
  const seen = new Map<string, { label: string; plan: string; n: number }>();
  for (const r of rows) seen.set(r.plan_version.id, { label: `${planTitle(r.plan)} v${r.plan_version.version_number}`, plan: r.plan.name, n: r.plan_version.version_number });
  return [...seen.entries()]
    .sort(([, a], [, b]) => a.plan.localeCompare(b.plan) || a.n - b.n)
    .map(([value, v]) => ({ value, label: v.label }));
}

/** The design's `verOpts`: every non-draft version of each catalog plan, by plan order then version. */
export function catalogVersionOptions(c: Catalog): { readonly value: string; readonly label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const p of c.products) {
    for (const plan of [...p.plans].sort((a, b) => a.display_order - b.display_order)) {
      for (const v of [...plan.versions].sort((a, b) => a.version_number - b.version_number)) {
        if (v.status !== 'DRAFT') out.push({ value: v.id, label: `${planTitle(plan)} v${v.version_number}` });
      }
    }
  }
  return out;
}

// ── Tenant › Commercial (handoff §5.9) ───────────────────────────────────────────────────────

export const ENTITLEMENT_PILL: Readonly<Record<EntitlementFacts['state'], { readonly label: string; readonly tone: PlatformTone }>> = {
  ACTIVE: { label: 'Entitlement active', tone: 'ok' },
  REVOKED: { label: 'Revoked', tone: 'muted' },
  NONE: { label: 'Not granted', tone: 'neutral' },
};

const COMMERCIAL_SOURCES = ['MANUAL', 'PLAN', 'PROMOTION'];

function grantedBy(e: EntitlementFacts): string {
  if (e.granted_source === 'PROVISIONING') return 'Granted by provisioning';
  if (e.granted_source === 'SIGNUP') return 'Granted by signup';
  if (e.granted_source === 'MIGRATION') return 'Migrated — provenance: migration';
  if (e.granted_source !== null && COMMERCIAL_SOURCES.includes(e.granted_source)) {
    return e.change_request_id ? `Granted by change request ${crRef(e.change_request_id)}` : 'Granted by change request';
  }
  return 'Granted';
}

/** The right-aligned provenance line (handoff §5.9 "Provenance"; CCP-A7 `granted_source`). */
export function provenanceText(e: EntitlementFacts): string {
  if (e.state === 'NONE') return '';
  if (e.state === 'REVOKED') {
    const ref = e.revoke_change_request_id ? ` · ${crRef(e.revoke_change_request_id)}` : '';
    return `Revoked ${dayLabel(e.revoked_at)}${ref} · was ${grantedBy(e).replace(/ CR-[0-9A-F]{8}$/, '').toLowerCase()}`;
  }
  return `${grantedBy(e)} · ${dayLabel(e.granted_at)}`;
}

export interface Fact {
  readonly k: string;
  readonly v: string;
  readonly s: string;
  readonly tone?: PlatformTone;
}

export function subscriptionFacts(s: SubscriptionFacts, now: Date): Fact[] {
  const st = statusView(s, now);
  const contractPriced = s.plan.sales_model === 'CONTACT_SALES';
  return [
    { k: 'Plan', v: planTitle(s.plan), s: contractPriced ? 'Contract-priced' : '' },
    { k: 'Plan version', v: `v${s.plan_version.version_number} · pinned`, s: s.plan_version.status === 'RETIRED' ? 'Retired — grandfathered' : '' },
    { k: 'Status', v: st.label, s: st.line, tone: st.tone },
    { k: 'Current period', v: periodText(s), s: '' },
    {
      k: 'Commitment end',
      v: s.commitment_end ? dayLabel(s.commitment_end) : 'None',
      s: s.contract ? `Contract ${s.contract.contract_ref}` : s.source === 'SELF_SERVICE' ? 'Self-service, no commitment' : '',
    },
  ];
}

/** The allowance bar (handoff §5.9): 6px, warn fill at 90% or more. */
export function allowanceBar(used: number, limit: number | null): { readonly text: string; readonly pct: number; readonly warn: boolean } {
  if (limit === null) return { text: `${used.toLocaleString('en-US')} envelopes · unlimited`, pct: 0, warn: false };
  const pct = limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return { text: `${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} envelopes`, pct, warn: pct >= 90 };
}

/** The held-activation reasons (Conv. C-7; A6 `governed_subscription_open`; Signup A1, P3 holds). */
export const GOVERNED_HOLD = 'governed_subscription_open';

export function flagTitle(f: HeldFlag): string {
  if (f.reason === GOVERNED_HOLD) return 'Reconciliation flag · self-service checkout blocked.';
  if (f.reason === 'billing_country_not_supported') return 'Reconciliation flag · activation held: billing country not supported.';
  if (f.reason === 'domain_not_authoritative') return 'Reconciliation flag · activation held: domain not verified.';
  return `Reconciliation flag · activation held (${f.reason}).`;
}

export function flagDetail(f: HeldFlag, s: SubscriptionFacts | null): string {
  if (f.reason !== GOVERNED_HOLD) return `The provider subscription ${f.subscription_ref} was not activated. Detected ${dayLabel(f.detected_at)}.`;
  const on = s?.contract ? ` on contract ${s.contract.contract_ref}` : '';
  return `A self-service checkout would have ended the governed MANUAL subscription${on}. Checkout was blocked.`;
}

/** A release request that ended without applying (B5-R: APPLY_EXPIRED can reach a CONVERSION). */
export const ENDED_UNAPPLIED = ['APPLY_EXPIRED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'];

/** True when the hold still needs a (new) release request. */
export function needsRelease(f: HeldFlag): boolean {
  return f.conversion === null || ENDED_UNAPPLIED.includes(f.conversion.state);
}

/** The release state line (design `reconState`); "Sent to Stripe — awaiting confirmation" while the C1 command is unconfirmed. */
export function releaseState(f: HeldFlag): string {
  if (f.conversion === null) return 'Needs a Commercial ops release request.';
  if (ENDED_UNAPPLIED.includes(f.conversion.state)) return `Release request ${(REQUEST_STATE_LABEL[f.conversion.state] ?? f.conversion.state).toLowerCase()}; needs a new Commercial ops release request:`;
  return f.conversion.state === 'APPLYING' ? 'Release sent to Stripe — awaiting confirmation:' : 'Release request:';
}

export const REQUEST_STATE_LABEL: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  APPLYING: 'Applying',
  APPLIED: 'Applied',
  APPLY_FAILED: 'Apply failed',
  APPLY_EXPIRED: 'Apply expired',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
};

/** "Plan change · pending approval. Other requests on this product wait until it closes." */
export function openRequestText(r: OpenRequestRef, pendingProvider: boolean): string {
  const state = r.state === 'APPLYING' && pendingProvider ? 'sent to Stripe — awaiting confirmation' : (REQUEST_STATE_LABEL[r.state] ?? r.state).toLowerCase();
  return `${actionLabel(r.action_type)} · ${state}. Other requests on this product wait until it closes.`;
}

// ── actions and their reasons (handoff §5.9 "Actions", design `act`) ────────────────────────

export type TenantActionKey = 'plan' | 'cancel' | 'grant' | 'revoke' | 'extension' | 'convert';

export interface TenantAction {
  readonly key: TenantActionKey;
  readonly label: string;
  readonly danger: boolean;
  /** The domain reason (listed under the actions); "" when none. */
  readonly domain: string;
  /** The tooltip: the domain reason, else the role reason, else the open-request reason. */
  readonly why: string;
  readonly disabled: boolean;
}

export interface ActionContext {
  readonly product: ProductCommercial;
  readonly canSubscription: boolean;
  readonly canEntitlement: boolean;
  readonly canSupport: boolean;
  readonly human: boolean;
  readonly now: Date;
}

const OPS = 'Needs the Commercial ops role.';
const SUPPORT = 'Needs the Support admin role.';

/** The product capability a governed grant / revoke names (the A6 bundle `sign → [core, sign]`; `core` is never revocable, A7). */
export function grantCapabilities(product: string): string[] {
  return product === 'sign' ? ['core', 'sign'] : [product];
}
export function revokeCapabilities(product: string): string[] {
  return [product];
}

/** True while a self-service row is inside its commitment term (DR-C2-1: conversion refused). */
export function insideCommitment(s: Pick<SubscriptionFacts, 'commitment_end'>, now: Date): boolean {
  return s.commitment_end !== null && new Date(s.commitment_end).getTime() > now.getTime();
}

export function tenantActions(ctx: ActionContext): TenantAction[] {
  const { product: p, now } = ctx;
  const s = p.subscription;
  const open = s !== null && s.ended_at === null;
  const self = open && isStripeOwned(s);
  const contractPriced = s !== null && s.plan.sales_model === 'CONTACT_SALES';
  const blocked = p.open_request !== null;
  const openWhy = p.open_request ? `Open request ${crRef(p.open_request.id)}. Other requests on this product wait until it closes.` : '';
  const make = (key: TenantActionKey, label: string, domain: string, roleOk: boolean, roleWhy: string, danger = false): TenantAction => ({
    key,
    label,
    danger,
    domain,
    why: domain || (roleOk && ctx.human ? '' : roleWhy) || openWhy,
    disabled: domain !== '' || !roleOk || !ctx.human || blocked,
  });
  const noPlans = p.registered ? '' : 'No commercial plans yet.';
  const out: TenantAction[] = [
    make(
      'plan',
      'Request plan change…',
      noPlans || (!open ? 'No open subscription.' : self ? 'Managed in Stripe. The tenant changes plans in Stripe checkout.' : contractPriced ? 'Enterprise is contract-priced; record a contract amendment instead.' : ''),
      ctx.canSubscription,
      OPS,
    ),
    make('cancel', 'Request cancel…', !open ? 'No open subscription.' : self ? 'Managed in Stripe. Cancellation happens in Stripe.' : '', ctx.canSubscription, OPS, true),
  ];
  const noGoverned = p.registered ? '' : 'No governed request covers this product yet.';
  if (p.entitlement.state === 'ACTIVE') out.push(make('revoke', 'Revoke product…', noGoverned, ctx.canEntitlement, OPS, true));
  else out.push(make('grant', 'Grant product…', noGoverned, ctx.canEntitlement, OPS));
  out.push(make('extension', 'Request support extension…', !open ? 'No open subscription.' : '', ctx.canSupport, SUPPORT));
  if (self) {
    // CCP-C2 self-service → governed (TD-B3-4): the Stripe-owned row ends through a durable command.
    out.push(
      make(
        'convert',
        'Request conversion to MANUAL…',
        insideCommitment(s, now) ? `Inside its commitment term until ${dayLabel(s.commitment_end)}: ending it early has no ruled financial treatment (FINANCIAL_TREATMENT_UNDEFINED).` : '',
        ctx.canSubscription,
        OPS,
      ),
    );
  }
  return out;
}

// ── refusals (409 / 403 from the governed routes) ───────────────────────────────────────────

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  FINANCIAL_TREATMENT_UNDEFINED:
    'This self-service subscription is inside its commitment term, and ending it early has no ruled financial treatment (decision request DR-C2-1). Nothing was sent to Stripe; the request stays Apply failed.',
  STRIPE_OWNED: 'The subscription is owned by Stripe; Aramo does not edit it. Use a conversion instead.',
  TARGET_STALE: 'The subscription changed after the request was made. Make a new request.',
  USAGE_EXCEEDS_NEW_LIMIT: 'Usage this period already exceeds the new allowance.',
  USAGE_TREATMENT_UNDEFINED: 'The usage treatment for this change is not defined, so it fails closed.',
  APPLY_EXPIRED: 'The apply deadline has passed. Make a new request.',
};

/** The refusal line for a failed create, apply or convert. */
export function refusalLine(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again in a minute.';
  const d = err.details ?? {};
  const reason = typeof d['reason'] === 'string' ? d['reason'] : null;
  const failure = typeof d['failure'] === 'string' ? d['failure'] : typeof d['code'] === 'string' ? d['code'] : null;
  const refusal = typeof d['refusal'] === 'string' ? d['refusal'] : null;
  const explanation = typeof d['explanation'] === 'string' ? d['explanation'] : null;
  const code = `${err.status} ${err.code ?? 'ERROR'}${reason ? ` · ${reason}` : ''}`;
  if (reason === 'apply_failed' && failure) return `Apply failed: ${failure}. ${FAILURE_TEXT[failure] ?? explanation ?? err.message} (${code})`;
  if (reason === 'apply_expired') return `Refused: ${FAILURE_TEXT['APPLY_EXPIRED']} (${code})`;
  if (reason === 'apply_refused' && refusal) return `Refused: ${refusal}. ${explanation ?? 'Nothing changed.'} (${code})`;
  if (reason === 'open_request_exists') return `Refused: another request on this product is open. It must close first. (${code})`;
  if (reason === 'not_requester') return `Refused: only the person who made the request can apply it. (${code})`;
  if (err.status === 403) return `Refused: your account doesn’t hold the permission for this. (${code})`;
  return `Refused: ${explanation ?? err.message}. (${code})`;
}
