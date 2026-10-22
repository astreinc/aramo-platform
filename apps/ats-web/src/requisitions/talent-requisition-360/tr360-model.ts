// Talent × Requisition 360 — pure presentation mapping. Every value here is a
// DISPLAY projection of a server-owned fact (pipeline status, composed journey,
// board card, Talent 360 read). Nothing in this file decides eligibility, stage
// legality or readiness; those stay with the owning domain.

import { ApiError } from '@aramo/fe-foundation';

import type { PipelineStatus } from '../../pipeline/types';
import type {
  RecruitingAvailableAction,
  TalentRequisitionJourney,
} from '../../pipeline/talent-journey-api';
import type { BoardCardView, RequisitionTalentBoardView } from '../requisition-talent-board-api';
import type { RequisitionProfileView } from '../golden-profile';
import type { RecentActivityItemView } from '../../talent-360/talent-360-types';

// ── Status pill palette (§3) ────────────────────────────────────────────────
export type PillTone = 'green' | 'amber' | 'blue' | 'grey' | 'red';

// ── Stage stepper (§3.3.3) ──────────────────────────────────────────────────
export const STEPS = [
  { key: 'no_contact', label: 'Not contacted' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'responded', label: 'Talent responded' },
  { key: 'qualifying', label: 'Qualifying' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
] as const;
export type StepKey = (typeof STEPS)[number]['key'];

const PIPELINE_STEP: Partial<Record<PipelineStatus, number>> = {
  no_contact: 0,
  contacted: 1,
  talent_responded: 2,
  qualifying: 3,
  qualified: 4,
};

// Downstream funnel stages from the composed journey (server-owned
// current_journey_stage). Recruiting stages fall through to the Pipeline status.
const JOURNEY_STEP: Readonly<Record<string, number>> = {
  SUBMITTED: 5,
  CLIENT_REVIEW: 5,
  CLIENT_DECLINED: 5,
  INTERVIEW: 6,
  OFFER: 7,
  ACCEPTED_PLACED: 7,
  PRE_START: 7,
  READY: 7,
  STARTED: 7,
  COMPLETED: 7,
};

/** Index of the current step, or -1 when the episode is closed / not on the ladder. */
export function currentStepIndex(
  status: PipelineStatus | null,
  journey: TalentRequisitionJourney | null,
): number {
  const downstream = journey !== null ? JOURNEY_STEP[journey.current_journey_stage] : undefined;
  if (downstream !== undefined) return downstream;
  if (status === null) return -1;
  return PIPELINE_STEP[status] ?? -1;
}

export type StepState = 'done' | 'current' | 'future';
export function stepState(i: number, current: number): StepState {
  if (current < 0) return 'future';
  if (i < current) return 'done';
  if (i === current) return 'current';
  return 'future';
}

// ── Domain primary action (§3.3.2) ──────────────────────────────────────────
// Copy for the server-offered recruiting action. The header renders the FIRST
// action the server returns in `recruiting_available_actions`; the FE never
// computes eligibility from stage equality.
export interface PrimaryActionCopy {
  readonly label: string;
  readonly tip: string;
  readonly dispatch: 'contact' | 'record_response' | 'decision';
  readonly to?: 'qualifying' | 'qualified';
}
export const PRIMARY_ACTION_COPY: Record<RecruitingAvailableAction, PrimaryActionCopy> = {
  contact_talent: { label: 'Contact Talent', tip: 'Open the email composer for this Talent', dispatch: 'contact' },
  record_talent_response: {
    label: 'Record response',
    tip: 'Record how the Talent responded',
    dispatch: 'record_response',
  },
  start_qualifying: { label: 'Start qualifying', tip: 'Advance to Qualifying (your decision)', dispatch: 'decision', to: 'qualifying' },
  mark_qualified: { label: 'Mark qualified', tip: 'Advance to Qualified (your decision)', dispatch: 'decision', to: 'qualified' },
};

// ATS-QA-1 5.1 — why the decision primary is not offered. The journey withholds
// "Mark qualified" while the Right to Represent precondition is unmet, so the tip
// names that real reason from the board's signing status (already on the client).
// Display only: the server still decides what is offered.
export const PRIMARY_NOT_OFFERED_TIP = 'Not available yet — the recruiting workflow has not offered this step';
export function disabledPrimaryReason(
  status: PipelineStatus | null,
  rtrStatus: BoardCardView['rtr_status'] | null,
): string {
  if (status === 'qualifying') {
    switch (rtrStatus) {
      case 'NOT_SENT':
        return 'Needs a signed Right to Represent. None has been sent yet.';
      case 'SENT':
        return 'Needs a signed Right to Represent. It is awaiting signature.';
      case 'DECLINED':
        return 'Needs a signed Right to Represent. The last one was declined.';
      case 'EXPIRED':
        return 'Needs a signed Right to Represent. The last one expired unsigned.';
      case 'POLICY_UNRESOLVED':
        return 'No Right to Represent policy is set for this client. Ask an admin to set it.';
      default:
        break;
    }
  }
  return PRIMARY_NOT_OFFERED_TIP;
}

// ATS-QA-1 D8 — a stale action refused by the optimistic-concurrency check.
export const STAGE_CONFLICT_MESSAGE = "This talent's stage has already changed. The page now shows the latest status.";
export function isStageConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PIPELINE_TRANSITION_CONFLICT';
}

// ATS-QA-1 A3 — the notes the Talent 360 read actually produces. A note is an
// activity-log row (id `activity:…`) which the API files under the
// 'requisitions' category with the title "Note added"; there is no 'note'
// category. Notes are Talent-level (no requisition), or on this requisition.
export const NOTE_ACTIVITY_TITLE = 'Note added';
export function tr360Notes(
  items: readonly RecentActivityItemView[],
  reqId: string,
): readonly RecentActivityItemView[] {
  return items.filter(
    (a) =>
      a.id.startsWith('activity:') &&
      a.category === 'requisitions' &&
      a.title === NOTE_ACTIVITY_TITLE &&
      (a.requisition_id === null || a.requisition_id === reqId),
  );
}

// ATS-QA-1 D13 — the "must-haves are highlighted on Overview" copy is shown only
// when the requisition profile has must-haves. Nothing compares them with the
// Talent's skills.
export function hasMustHaveSkills(profile: RequisitionProfileView | null): boolean {
  return requisitionSkills(profile).some((s) => s.must);
}

// ── Prev / next within the requisition (§3.3.1) ─────────────────────────────
// Pipeline order = the board's server-ordered columns, then card order within each.
export function pipelineOrder(board: RequisitionTalentBoardView | null): readonly string[] {
  if (board === null) return [];
  const ids: string[] = [];
  for (const col of board.columns) for (const c of col.cards) ids.push(c.talent_record_id);
  return ids;
}

export function findCard(
  board: RequisitionTalentBoardView | null,
  talentId: string,
): BoardCardView | null {
  if (board === null) return null;
  for (const col of board.columns) {
    const c = col.cards.find((x) => x.talent_record_id === talentId);
    if (c !== undefined) return c;
  }
  return null;
}

// ── Right to Represent (qualifying row + recruiter view) ────────────────────
export interface RtrPresentation {
  readonly pill: string;
  readonly tone: PillTone;
  readonly fact: string;
  readonly done: boolean;
}
/** null ⇒ RTR is ungoverned for this requisition — the row is not shown. */
export function rtrPresentation(card: BoardCardView | null): RtrPresentation | null {
  switch (card?.rtr_status ?? null) {
    case 'CONFIRMED':
      return { pill: 'Signed', tone: 'green', fact: 'Signed', done: true };
    case 'SENT':
      return { pill: 'Awaiting signature', tone: 'amber', fact: 'Awaiting signature', done: false };
    case 'NOT_SENT':
      return { pill: 'Not sent', tone: 'grey', fact: 'Not sent', done: false };
    // Pipeline & RTR Recon Remediation Directive v1.0 R2 (DEF-12) — ended unsigned; send a new RTR.
    case 'DECLINED':
      return { pill: 'Declined', tone: 'amber', fact: 'Declined by the talent — send a new RTR', done: false };
    case 'EXPIRED':
      return { pill: 'Expired', tone: 'amber', fact: 'Expired unsigned — send a new RTR', done: false };
    case 'NOT_REQUIRED':
      return { pill: 'Not required', tone: 'grey', fact: 'Not required', done: true };
    // Talent Lifecycle R1–R5 Impl Directive v1.2 §4.7 — requirement not configured.
    case 'POLICY_UNRESOLVED':
      return { pill: 'Policy not set', tone: 'amber', fact: 'Policy not set', done: false };
    default:
      return null;
  }
}

// ── Requisition skills (§4.2) ───────────────────────────────────────────────
// "Must-have" = the profile's critical + required groups; "other" = preferred.
export interface SkillChip {
  readonly label: string;
  readonly must: boolean;
}
export function requisitionSkills(profile: RequisitionProfileView | null): readonly SkillChip[] {
  if (profile === null || !profile.has_profile) return [];
  const seen = new Set<string>();
  const out: SkillChip[] = [];
  const push = (name: string, must: boolean): void => {
    const k = name.trim().toLowerCase();
    if (k === '' || seen.has(k)) return;
    seen.add(k);
    out.push({ label: name.trim(), must });
  };
  for (const s of profile.critical_skills) push(s.name, true);
  for (const s of profile.required_skills) push(s.name, true);
  for (const s of profile.preferred_skills) push(s.name, false);
  return out;
}

// ── Formatting ──────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 11 · 16:12" (local time) — the activity timestamp column. */
export function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} · ${hh}:${mm}`;
}

/** "Oct 20, 2026" from a date-only or ISO string (UTC date — no TZ shift). */
export function formatLongDate(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Oct 7" — short date for step summaries. */
export function formatShortDate(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// requisitions/types.ts RATE_PERIOD_VALUES → display suffix.
const RATE_PERIOD_SUFFIX: Readonly<Record<string, string>> = {
  HOURLY: '/hr',
  DAILY: '/day',
  WEEKLY: '/wk',
  MONTHLY: '/mo',
  ANNUAL: '/yr',
};

/** "$62/hr" from an amount + period; null when the amount is masked/absent. */
export function rateLabel(amount: string | null, period: string | null): string | null {
  if (amount === null || amount.trim() === '') return null;
  const n = Number(amount);
  const value = Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : amount;
  const per = period !== null ? (RATE_PERIOD_SUFFIX[period] ?? '') : '';
  return `$${value}${per}`;
}

// ── Sections & tabs (§3.2 / §3.3.4) ─────────────────────────────────────────
export const SECTION_KEYS = [
  'overview',
  'exp',
  'skills',
  'auth',
  'opp',
  'act',
  'docs',
  'comm',
  'trust',
  'ci',
  'screening',
  'notes',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const TAB_KEYS = ['overview', 'ci', 'screening', 'submittal', 'tasks', 'notes'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

/** A content view = a tab, a section summary, or a stage-step summary. */
export type ViewKey = SectionKey | TabKey | `step:${StepKey}`;

export function isViewKey(v: string | null): v is ViewKey {
  if (v === null) return false;
  if ((SECTION_KEYS as readonly string[]).includes(v)) return true;
  if ((TAB_KEYS as readonly string[]).includes(v)) return true;
  return v.startsWith('step:') && STEPS.some((s) => `step:${s.key}` === v);
}

/** The tab a view highlights (null ⇒ none). */
export function tabForView(v: ViewKey): TabKey | null {
  return (TAB_KEYS as readonly string[]).includes(v) ? (v as TabKey) : null;
}
/** The section a view highlights (null ⇒ none). */
export function sectionForView(v: ViewKey): SectionKey | null {
  return (SECTION_KEYS as readonly string[]).includes(v) ? (v as SectionKey) : null;
}
