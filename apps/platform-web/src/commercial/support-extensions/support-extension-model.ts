import type { ExtensionClause, SupportChangeRequest, SupportExtension, SupportPolicy, SupportSubscription } from './support-extension-api';

// CCP-B6 — the pure half of the support-extension screen (CCP-UI v1.0 handoff §5.9, §5.10;
// Commercial Control Plane v1.0.dc.html `dlgExt`, the exception overlay, `extUse`).
//
// The live preview MIRRORS the server's bound (CCP-A8 `decideSupportExtension` over the A2
// `checkSupportExtension`, decisions A2-B and TD-A2-1): length ≤ max days; no extension in the
// rolling frequency window (half-open); cumulative days in the rolling cumulative window ≤ the
// cap; the row PAST_DUE. Every overlay of the tenant × product counts, bounded or approved,
// removed or not (TD-A8-4). The preview never decides: the POST does, and its answer wins.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The commercial role labels (handoff §3). */
export const COMMERCIAL_ROLE_LABEL: Readonly<Record<string, string>> = {
  platform_owner: 'Platform owner',
  finance_admin: 'Finance admin',
  commercial_ops: 'Commercial ops',
  catalog_manager: 'Catalog manager',
  support_admin: 'Support admin',
  read_only_auditor: 'Read-only auditor',
  super_admin: 'Super admin',
};

export function roleLabels(keys: readonly string[]): string {
  return keys.length === 0 ? '—' : keys.map((k) => COMMERCIAL_ROLE_LABEL[k] ?? k).join(', ');
}

/** The design's `fD`: "24 Oct 2026" (UTC). */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The design's `fT`: "2026-10-03 16:40 UTC". */
export function stampLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The design's `rel`: "21 d ago" · "5 h ago" · "in 4 d". */
export function relLabel(iso: string, now: Date): string {
  const df = now.getTime() - new Date(iso).getTime();
  const a = Math.abs(df);
  const f = a < HOUR_MS ? `${Math.max(1, Math.round(a / 60_000))} min` : a < 2 * DAY_MS ? `${Math.round(a / HOUR_MS)} h` : `${Math.round(a / DAY_MS)} d`;
  return df >= 0 ? `${f} ago` : `in ${f}`;
}

/** A short, stable reference for a UUID (first 8 hex, upper case). */
export function shortRef(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** The full clause when the policy carries all four values; null otherwise (fail closed: no preview). */
export function fullClause(c: Partial<ExtensionClause> | null | undefined): ExtensionClause | null {
  if (!c) return null;
  const { support_extension_max_days: a, support_extension_frequency_window_days: b, support_extension_cumulative_max_days: d, support_extension_cumulative_window_days: e } = c;
  return [a, b, d, e].every((v) => typeof v === 'number') ? (c as ExtensionClause) : null;
}

/** "Policy v1: up to 14 days, once per tenant per 90 days, 30 days cumulative." (help line, §5.9). */
export function clauseHelp(policy: SupportPolicy): string {
  const c = fullClause(policy.clause);
  if (c === null) return `Policy v${policy.version_number}.`;
  return `Policy v${policy.version_number}: up to ${c.support_extension_max_days} days, once per tenant per ${c.support_extension_frequency_window_days} days, ${c.support_extension_cumulative_max_days} days cumulative.`;
}

const inWindow = (at: string, now: Date, days: number): boolean => new Date(at).getTime() > now.getTime() - days * DAY_MS;

export interface ExtensionUse {
  /** Extensions applied inside the rolling frequency window. */
  readonly uses: number;
  /** Days applied inside the rolling cumulative window. */
  readonly cumulative: number;
  /** The newest extension inside the frequency window (for the reason line). */
  readonly lastInWindow: SupportExtension | null;
}

export function extensionUse(prior: readonly SupportExtension[], clause: ExtensionClause, now: Date): ExtensionUse {
  const inFreq = prior.filter((p) => inWindow(p.applied_at, now, clause.support_extension_frequency_window_days));
  const cumulative = prior.filter((p) => inWindow(p.applied_at, now, clause.support_extension_cumulative_window_days)).reduce((s, p) => s + p.days, 0);
  const lastInWindow = [...inFreq].sort((x, y) => y.applied_at.localeCompare(x.applied_at))[0] ?? null;
  return { uses: inFreq.length, cumulative, lastInWindow };
}

/** CCP-R3 (TD-A8-3 refined): only a limit breach escalates; eligibility is a separate refusal. */
export type PreviewBreach = 'LENGTH' | 'FREQUENCY' | 'CUMULATIVE';

/** The copy of an eligibility refusal (the server's SUPPORT_EXTENSION_INELIGIBLE). */
export const INELIGIBLE_NOT_PAST_DUE = 'The subscription isn’t past due, so a support extension isn’t available. Nothing will be requested or escalated.';
export const INELIGIBLE_NOT_ATTESTED = 'Your account has no active one-person attestation, so a support extension isn’t available. Nothing was requested or escalated.';

export interface ExtensionPreview {
  readonly days: number;
  /** CCP-R3: false → the request is refused (not escalated); the dialog cannot submit it. */
  readonly eligible: boolean;
  readonly withinBounds: boolean;
  readonly breaches: readonly PreviewBreach[];
  /** The ineligibility line when not eligible; else the first breach's line (design order: length, frequency, cumulative). */
  readonly why: string;
  readonly use: ExtensionUse;
}

/**
 * The live preview for `days` (null when `days` is not a positive whole number, or when no full
 * policy clause is available: the design shows no preview box then).
 */
export function previewExtension(input: {
  readonly days: number;
  readonly prior: readonly SupportExtension[];
  readonly policy: SupportPolicy | null;
  readonly subscription: SupportSubscription | null;
  readonly now: Date;
}): ExtensionPreview | null {
  const { days } = input;
  const clause = fullClause(input.policy?.clause);
  if (clause === null || !Number.isInteger(days) || days < 1) return null;
  const use = extensionUse(input.prior, clause, input.now);
  const breaches: PreviewBreach[] = [];
  if (days > clause.support_extension_max_days) breaches.push('LENGTH');
  if (use.uses > 0) breaches.push('FREQUENCY');
  if (use.cumulative + days > clause.support_extension_cumulative_max_days) breaches.push('CUMULATIVE');
  // The attestation is the server's to check; the row's status is known here.
  const eligible = input.subscription?.status === 'PAST_DUE';
  const first = breaches[0];
  const why = !eligible
    ? INELIGIBLE_NOT_PAST_DUE
    : first === 'LENGTH'
      ? `More than ${clause.support_extension_max_days} days in one extension.`
      : first === 'FREQUENCY'
        ? `A previous extension was used ${use.lastInWindow ? relLabel(use.lastInWindow.applied_at, input.now) : 'recently'}, inside the ${clause.support_extension_frequency_window_days}-day window.`
        : first === 'CUMULATIVE'
          ? `Cumulative days would exceed ${clause.support_extension_cumulative_max_days}.`
          : '';
  return { days, eligible, withinBounds: breaches.length === 0, breaches, why, use };
}

/** The server's limit-breach codes → the same first-match line (after a POST that escalated). */
export function breachLine(breaches: readonly string[], clause: Record<string, number> | null | undefined): string {
  const c = clause ?? {};
  if (breaches.includes('LENGTH')) return `More than ${c['support_extension_max_days'] ?? '—'} days in one extension.`;
  if (breaches.includes('FREQUENCY')) return `A previous extension was used inside the ${c['support_extension_frequency_window_days'] ?? '—'}-day window.`;
  if (breaches.includes('CUMULATIVE')) return `Cumulative days would exceed ${c['support_extension_cumulative_max_days'] ?? '—'}.`;
  return 'It is outside the policy bounds.';
}

/** CCP-R3 — the server's eligibility refusal (409 support_extension_ineligible) → one line. */
export function ineligibleLine(eligibility: readonly string[]): string {
  if (eligibility.includes('REQUESTER_NOT_ATTESTED')) return INELIGIBLE_NOT_ATTESTED;
  return INELIGIBLE_NOT_PAST_DUE.replace('Nothing will be requested', 'Nothing was requested');
}

// ── subscription facts (handoff §5.9 "Subscription facts", §5.3 status) ──────────────────────

export interface StatusFact {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';
  readonly sub: string;
}

export function statusFact(s: SupportSubscription, now: Date): StatusFact {
  if (s.status === 'PAST_DUE') {
    const graceLeft = s.grace_until !== null && new Date(s.grace_until).getTime() > now.getTime();
    return {
      label: graceLeft ? 'Past due · in grace' : 'Past due',
      tone: 'warn',
      sub: s.grace_until ? `${graceLeft ? 'Grace ends' : 'Grace ended'} ${dayLabel(s.grace_until)} (${relLabel(s.grace_until, now)})` : '',
    };
  }
  const T: Record<string, StatusFact> = {
    ACTIVE: { label: 'Active', tone: 'ok', sub: '' },
    TRIALING: { label: 'Trialing', tone: 'neutral', sub: '' },
    INCOMPLETE: { label: 'Incomplete', tone: 'neutral', sub: '' },
    CANCELED: { label: 'Canceled', tone: 'muted', sub: '' },
  };
  return T[s.status] ?? { label: s.status, tone: 'neutral', sub: '' };
}

/** Source badge (§5.3): "Managed in Stripe" for self-service, else "MANUAL · contract". */
export function sourceBadge(s: SupportSubscription): { readonly label: string; readonly stripe: boolean } {
  return s.source === 'SELF_SERVICE' ? { label: 'Managed in Stripe', stripe: true } : { label: 'MANUAL · contract', stripe: false };
}

// ── the exception overlay (handoff §5.9 "Exception overlay") ────────────────────────────────

export interface OverlayView {
  readonly id: string;
  readonly ref: string;
  readonly exception: boolean;
  readonly title: string;
  readonly actor: string;
  readonly roles: string;
  readonly clause: string;
  readonly uses: string;
  readonly cumulative: string;
  readonly billing: string;
  readonly until: string;
}

export function overlayView(e: SupportExtension, ctx: { readonly all: readonly SupportExtension[]; readonly policy: SupportPolicy | null; readonly subscription: SupportSubscription | null; readonly meId: string; readonly meName: string; readonly now: Date }): OverlayView {
  const c = fullClause(e.context?.clause) ?? fullClause(ctx.policy?.clause);
  const v = e.context?.policy_version_number ?? null;
  const window = c?.support_extension_frequency_window_days ?? 90;
  const counters = e.context?.counters ?? null;
  const uses = c === null ? '—' : `${extensionUse(ctx.all, c, ctx.now).uses} of 1 in the last ${window} days`;
  const cumulative =
    counters && typeof counters.cumulative_days_before === 'number' && typeof counters.cumulative_days_after === 'number'
      ? `${counters.cumulative_days_before} → ${counters.cumulative_days_after} days (cap ${c?.support_extension_cumulative_max_days ?? '—'})`
      : '—';
  const self = (ctx.subscription?.source ?? 'SELF_SERVICE') === 'SELF_SERVICE';
  return {
    id: e.id,
    ref: `EXT-${shortRef(e.id)}`,
    exception: e.is_exception,
    title: e.is_exception ? `+${e.days} day support extension · applied with zero approvals` : `+${e.days} day support extension · approved through a change request`,
    actor: `${e.applied_by === ctx.meId ? ctx.meName : shortRef(e.applied_by)} · ${stampLabel(e.applied_at)}`,
    roles: roleLabels(e.context?.roles_at_apply ?? []),
    clause: e.is_exception
      ? c === null
        ? `Policy v${v ?? '—'}`
        : `Policy v${v ?? '—'} — up to ${c.support_extension_max_days} days per use, once per tenant per ${c.support_extension_frequency_window_days} days, ${c.support_extension_cumulative_max_days} days cumulative`
      : `Approved through ${shortRef(e.change_request_id)} (outside Policy v${v ?? '—'})`,
    uses,
    cumulative,
    billing: self ? 'Overlay only — Stripe period and invoices unchanged' : 'Overlay on the MANUAL period',
    until: dayLabel(e.extends_until),
  };
}

// ── open requests (handoff §5.9 "Open request", §4 states) ─────────────────────────────────

export const REQUEST_STATE_LABEL: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  APPLYING: 'Applying',
  APPLIED: 'Applied',
  APPLY_FAILED: 'Apply failed',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
};

/** "Support extension" or "Support extension removal" (the payload's operation). */
export function requestTypeLabel(r: SupportChangeRequest): string {
  return r.payload['operation'] === 'REMOVE' ? 'Support extension removal' : 'Support extension';
}

/** "Support extension · pending approval. Other requests on this product wait until it closes." */
export function openRequestText(r: SupportChangeRequest): string {
  return `${requestTypeLabel(r)} · ${(REQUEST_STATE_LABEL[r.state] ?? r.state).toLowerCase()}. Other requests on this product wait until it closes.`;
}

/** The approvals drawer for a request (B1 owns the drawer; linked by query). */
export function approvalsHref(id: string): string {
  return `/commercial/approvals?request=${encodeURIComponent(id)}`;
}
