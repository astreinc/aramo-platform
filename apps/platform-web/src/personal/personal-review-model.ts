import { ApiError } from '@aramo/fe-foundation';

import type { PillSpec } from '../components';
import type {
  AbuseReportOutcome,
  PersonalAbuseReport,
  PersonalReviewAction,
  PersonalReviewItem,
  PersonalRiskState,
} from '../platform-api';

// PLATFORM-UX-1 F-6 (handoff §8.1; amendment 3, 11; directive R-19) — the pure
// model of the Sign Personal review queue: human labels, the state → action
// table, the action dialogs' copy and the error mapping. Copy is taken from
// doc/design-reference/platform-admin/platform/Platform Admin.dc.html (PST, RPT,
// ACTL, PA_ACT, paAction, reportAction).

// ── signals ────────────────────────────────────────────────────────────────

// Human labels for the recorded signal keys (and the review reasons recorded on
// the account). An unknown key falls back to a sentence-cased form of the code;
// the raw code is always shown beside it in mono.
const SIGNAL_LABEL: Readonly<Record<string, string>> = {
  robot_check_low: 'Security check low',
  robot_check_failed: 'Security check failed',
  honeypot_filled: 'Hidden form field filled',
  network_hosting: 'Hosting, VPN or Tor network',
  network_hosting_vpn_tor: 'Hosting, VPN or Tor network',
  ip_velocity: 'Several signups from the same IP',
  ip_signups_24h: 'Several signups from the same IP',
  phone_ip_country_mismatch: 'Phone country differs from network country',
  // GeoLite2 network location: a risk signal only, never proof of where someone lives.
  ip_country_outside: 'Network location outside the supported countries',
  ip_country_unknown: 'Network location unknown',
  gmail_alias: 'Gmail alias of an existing account',
  gmail_alias_of_existing: 'Gmail alias of an existing account',
  fast_form: 'Form completed very quickly',
  random_name: 'Random-looking name or address',
  random_looking: 'Random-looking name or address',
  phone_reused: 'Phone already used by another account',
  abuse_reports: 'Abuse reports',
  // Review reasons recorded on the account.
  send_location_outside: 'Sent from outside the supported countries',
  send_location_unknown: 'Sent from an unknown network location',
  step_up_phone_unavailable: 'Phone step needed; phone verification unavailable',
  signup_review: 'Signals passed the review threshold',
  signup_step_up: 'Phone step requested at signup',
  signup_step_up_unverified: 'Phone step requested at signup; phone not verified',
};

/** The number of signal / reason codes with a human label. */
export const SIGNAL_LABEL_COUNT = Object.keys(SIGNAL_LABEL).length;

const CODE_SHAPE = /^[a-z0-9_.]+$/;

/** True when `value` is a machine code (shown in mono beside its label). */
export function isCode(value: string): boolean {
  return CODE_SHAPE.test(value);
}

export function signalLabel(key: string): string {
  return SIGNAL_LABEL[key] ?? key.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The account's recorded reason: a known code gets its label; an operator's
 * free-text reason (recorded by a review action) is shown as written.
 */
export function reasonLabel(reason: string | null): string {
  if (reason === null || reason.trim() === '') return '—';
  return isCode(reason) ? signalLabel(reason) : reason;
}

/** The header total: the sum of the recorded signal points (R-19 — never a grade). */
export function signalTotal(item: Pick<PersonalReviewItem, 'signals'>): number {
  return item.signals.reduce((n, s) => n + s.points, 0);
}

// ── states ─────────────────────────────────────────────────────────────────

export type ReviewFilter = 'ALL' | PersonalRiskState;

export const REVIEW_FILTERS: readonly ReviewFilter[] = ['ALL', 'review', 'restricted', 'clear', 'closed'];

export const STATE_PILL: Readonly<Record<PersonalRiskState, PillSpec>> = {
  clear: { label: 'Clear', tone: 'ok' },
  review: { label: 'In review', tone: 'info' },
  restricted: { label: 'Restricted', tone: 'warn' },
  closed: { label: 'Closed', tone: 'muted' },
};

export function statePill(state: PersonalRiskState): PillSpec {
  return STATE_PILL[state] ?? { label: state, tone: 'neutral' };
}

export function filterLabel(f: ReviewFilter): string {
  return f === 'ALL' ? 'All' : statePill(f).label;
}

export type ReviewSort = 'signed' | 'until';

/** Filter + sort (Signed up, newest · Restricted until, soonest — no end last). */
export function visibleItems(items: readonly PersonalReviewItem[], filter: ReviewFilter, sort: ReviewSort): PersonalReviewItem[] {
  const list = items.filter((i) => filter === 'ALL' || i.state === filter);
  return list.sort((a, b) => {
    if (sort === 'signed') return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    const ua = a.restricted_until ?? '9';
    const ub = b.restricted_until ?? '9';
    return ua < ub ? -1 : ua > ub ? 1 : 0;
  });
}

// ── actions (handoff §8.1 state table) ─────────────────────────────────────

const ACTIONS_BY_STATE: Readonly<Record<PersonalRiskState, readonly PersonalReviewAction[]>> = {
  review: ['clear-review', 'restrict', 'close'],
  restricted: ['reinstate', 'close'],
  clear: ['restrict', 'close'],
  closed: [],
};

/** The footer actions for an account; a review owed under a restriction can be cleared too. */
export function actionsFor(it: Pick<PersonalReviewItem, 'state' | 'review_pending'>): PersonalReviewAction[] {
  const base = [...(ACTIONS_BY_STATE[it.state] ?? [])];
  return it.state === 'restricted' && it.review_pending === true ? [...base, 'clear-review'] : base;
}

/** The footer button label (… = opens a dialog that needs a reason). */
export const ACTION_BUTTON: Readonly<Record<PersonalReviewAction, string>> = {
  'clear-review': 'Clear review',
  restrict: 'Restrict…',
  reinstate: 'Reinstate…',
  close: 'Close account…',
};

export interface ActionSpec {
  /** The dialog title prefix and the commit label. */
  readonly label: string;
  readonly to: PersonalRiskState;
  readonly tone: 'normal' | 'privileged' | 'danger';
  readonly consequence: string;
}

const ACTION_SPEC: Readonly<Record<PersonalReviewAction, ActionSpec>> = {
  'clear-review': {
    label: 'Clear review',
    to: 'clear',
    tone: 'normal',
    consequence: 'The account returns to normal use. Signals stay on record.',
  },
  restrict: {
    label: 'Restrict account',
    to: 'restricted',
    tone: 'privileged',
    consequence: 'The account can’t send new envelopes. Existing envelopes keep working for recipients.',
  },
  reinstate: {
    label: 'Reinstate account',
    to: 'clear',
    tone: 'privileged',
    consequence: 'Sending is restored. The restriction stays in the account history.',
  },
  close: {
    label: 'Close account',
    to: 'closed',
    tone: 'danger',
    consequence: 'The account is closed and can’t send or sign in. Reports stay viewable.',
  },
};

/** The dialog spec for an action on an account (clearing an owed review keeps a restriction). */
export function actionSpec(action: PersonalReviewAction, it: Pick<PersonalReviewItem, 'state'>): ActionSpec {
  const spec = ACTION_SPEC[action];
  if (action === 'clear-review' && it.state === 'restricted') {
    return { ...spec, to: 'restricted', consequence: 'Marks the owed review as done. The restriction stays in place.' };
  }
  return spec;
}

export const REASON_MAX = 500;

/**
 * Merge a review action's response (the operator view of the risk state; the
 * client types it `unknown`) into the account snapshot. Missing fields fall
 * back to the action's expected outcome.
 */
export function applyRiskView(
  it: PersonalReviewItem,
  response: unknown,
  expected: { readonly to: PersonalRiskState; readonly reason: string; readonly clearedReview: boolean },
): PersonalReviewItem {
  const r = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>;
  const str = (k: string): string | null | undefined =>
    typeof r[k] === 'string' ? (r[k] as string) : r[k] === null ? null : undefined;
  const state = str('state');
  const known: readonly string[] = ['clear', 'review', 'restricted', 'closed'];
  const until = str('restricted_until');
  const phone = str('phone_verified_at');
  const cleared = str('step_up_cleared_by');
  return {
    ...it,
    state: state !== null && state !== undefined && known.includes(state) ? (state as PersonalRiskState) : expected.to,
    reason: str('reason') ?? expected.reason,
    restricted_until: until !== undefined ? until : expected.to === 'restricted' ? it.restricted_until : null,
    phone_verified_at: phone !== undefined ? phone : it.phone_verified_at,
    step_up_required: typeof r['step_up_required'] === 'boolean' ? (r['step_up_required'] as boolean) : it.step_up_required,
    step_up_cleared_by: cleared !== undefined ? cleared : it.step_up_cleared_by,
    review_pending: expected.clearedReview ? false : it.review_pending,
  };
}

/** A datetime-local value ("2026-11-07T00:00") read as UTC; null when empty or invalid. */
export function untilAsUtc(value: string): Date | null {
  if (value.trim() === '') return null;
  const d = new Date(`${value}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const UNTIL_IN_PAST = 'The “until” time is in the past. Choose a later time (until_in_past).';

// ── reports ────────────────────────────────────────────────────────────────

export const REPORT_PILL: Readonly<Record<AbuseReportOutcome, PillSpec>> = {
  OPEN: { label: 'Open', tone: 'info' },
  CONFIRMED: { label: 'Confirmed', tone: 'danger' },
  FALSE_REPORT: { label: 'False report', tone: 'neutral' },
  DISMISSED: { label: 'Dismissed', tone: 'muted' },
};

/** The abuse report categories (libs/sign ABUSE_REPORT_REASONS). */
const REPORT_CATEGORY: Readonly<Record<string, string>> = {
  phishing: 'Phishing',
  impersonation: 'Impersonation',
  spam: 'Spam',
  unknown_sender: 'Unknown sender',
  other: 'Other',
};

export function reportCategory(r: Pick<PersonalAbuseReport, 'reason'>): string {
  if (r.reason === null || r.reason === '') return 'No category recorded';
  return REPORT_CATEGORY[r.reason] ?? signalLabel(r.reason);
}

export type ReportDecision = Exclude<AbuseReportOutcome, 'OPEN'>;

export const REPORT_DECISIONS: readonly ReportDecision[] = ['CONFIRMED', 'FALSE_REPORT', 'DISMISSED'];

export const REPORT_BUTTON: Readonly<Record<ReportDecision, string>> = {
  CONFIRMED: 'Confirm…',
  FALSE_REPORT: 'Mark false report…',
  DISMISSED: 'Dismiss…',
};

export interface ReportDecisionSpec {
  readonly label: string;
  readonly tone: 'normal' | 'privileged';
  readonly consequence: string;
}

export function reportDecisionSpec(outcome: ReportDecision): ReportDecisionSpec {
  if (outcome === 'CONFIRMED') {
    return { label: 'Confirm report', tone: 'privileged', consequence: 'Confirmed reports add to the account’s evidence.' };
  }
  return {
    label: outcome === 'FALSE_REPORT' ? 'Mark as false report' : 'Dismiss report',
    tone: 'normal',
    consequence: 'The report stays on record with this outcome.',
  };
}

// ── phone ──────────────────────────────────────────────────────────────────

export function phoneLabel(it: Pick<PersonalReviewItem, 'phone_verified_at'>): string {
  return it.phone_verified_at !== null ? 'Verified' : 'Not verified';
}

/** The phone step, in words (the drawer "Phone" fact). */
export function phoneStepLabel(
  it: Pick<PersonalReviewItem, 'phone_verified_at' | 'step_up_required' | 'step_up_cleared_by'>,
): string {
  if (it.phone_verified_at !== null) return 'Phone step done';
  if (it.step_up_cleared_by === 'review') return 'Phone step lifted by review';
  if (it.step_up_required === true) return 'Phone step owed';
  return 'No phone step';
}

// ── errors ─────────────────────────────────────────────────────────────────

function reasonOf(e: ApiError): string | undefined {
  const r = e.details?.['reason'];
  return typeof r === 'string' ? r : undefined;
}

/** A review action / report decision refusal → the operator copy. */
export function reviewErrorText(e: unknown, it: Pick<PersonalReviewItem, 'state'>, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = reasonOf(e);
  if (reason === 'until_in_past') return UNTIL_IN_PAST;
  if (reason === 'illegal_risk_transition') {
    return `This change isn’t allowed from ${statePill(it.state).label} (illegal_risk_transition).`;
  }
  if (reason === 'no_personal_risk_state') {
    return 'This tenant isn’t a Sign Personal account, so it has no review state (no_personal_risk_state).';
  }
  return reason !== undefined ? `${e.message} (${reason})` : e.message;
}

/** A queue / reports load refusal → the operator copy. */
export function loadErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = reasonOf(e);
  return reason !== undefined ? `${e.message} (${reason})` : e.message;
}

// ── pilot invites (handoff §8.2) ───────────────────────────────────────────

export const INVITE_EMAIL_REQUIRED = 'Enter an email address.';
export const INVITE_PILOT_FULL = 'The pilot is full. No more invites can be sent until seats are released.';

export function inviteErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'The invite code couldn’t be created. Try again.';
  const reason = reasonOf(e);
  if (reason === 'personal_pilot_full') return INVITE_PILOT_FULL;
  if (reason === 'personal_email_required') {
    return 'Use a personal email address. Pilot invites are for Sign Personal accounts, not work domains (personal_email_required).';
  }
  if (e.code === 'VALIDATION_ERROR' && reason === undefined) return 'Enter a valid email address.';
  return reason !== undefined ? `${e.message} (${reason})` : e.message;
}
