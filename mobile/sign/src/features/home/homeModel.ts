// Home tab model (M-A4 §2; handoff §2A "Home tab"). Pure: derived from what the app
// already loads — the merged Agreements rows (sender list + inbox + local drafts,
// agreementsModel.mergeAgreements), the sender context and the billing account.
//
//   Welcome        — first word of the server's display_name; no name is ever guessed
//   Count chips    — Waiting for others / Drafts, the SAME definitions as the Agreements
//                    'waiting' / 'drafts' filters (agreementsModel.matchesFilter)
//   Assigned tasks — inbox items with `can_sign` ONLY (M-A2 claimed associations). Never
//                    an email match (M-A4 §2.4).
//   Activity       — the 5 most recent rows by activity
//   Plan banner    — Personal and Business with a counted allowance (M-A12 W1-D.3); copy below
import { countFor, needsMe, relativeTime, shortDate, type AgreementRow } from '../inbox/agreementsModel';
import { allowanceChipText, allowanceModel, limitBanner } from '../inbox/allowance';
import type { BillingAccount, InboxItem } from '../inbox/types';

export const ACTIVITY_LIMIT = 5;

/** "Priya" from "Priya Raman"; null when the server has no display name. */
export function firstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0];
  return first ? first : null;
}

export function welcomeText(displayName: string | null | undefined): string {
  const name = firstName(displayName);
  return name ? `Welcome, ${name}` : 'Welcome';
}

export type HomeChipFilter = 'waiting' | 'drafts';

export interface HomeChip {
  readonly filter: HomeChipFilter;
  readonly count: number;
  readonly label: string;
}

export function homeChips(rows: readonly AgreementRow[]): HomeChip[] {
  return [
    { filter: 'waiting', count: countFor(rows, 'waiting'), label: 'Waiting for others' },
    { filter: 'drafts', count: countFor(rows, 'drafts'), label: 'Drafts' },
  ];
}

export interface AssignedTask {
  readonly key: string;
  /** The INBOX ITEM id — the `Signing` route takes it (never a sender envelope id). */
  readonly inboxItemId: string;
  readonly subject: string;
  /** "From {sending organization} · {when}" — recipient facts only (§4.6). */
  readonly subtitle: string;
}

/**
 * Everything the server says the user can sign now: received rows with `can_sign`.
 * Rows come from mergeAgreements, so they are already newest first.
 */
export function assignedTasks(
  rows: readonly AgreementRow[],
  now: number = Date.now(),
): AssignedTask[] {
  const out: AssignedTask[] = [];
  for (const r of rows) {
    if (r.kind !== 'received' || !needsMe(r)) continue;
    out.push({
      key: r.key,
      inboxItemId: r.inboxItemId,
      subject: r.subject,
      subtitle: taskSubtitle(r.item, now),
    });
  }
  return out;
}

function taskSubtitle(item: InboxItem, now: number): string {
  const from = item.from ? `From ${item.from}` : 'Received';
  const when = relativeTime(item.sent_at, now);
  return when ? `${from} · ${when}` : from;
}

export function tasksHeading(count: number): string {
  return `Assigned tasks (${count})`;
}

export const NO_TASKS_TEXT = 'All clear for now';

/** The 5 most recent agreements (input is newest first; re-sorted defensively). */
export function recentActivity(
  rows: readonly AgreementRow[],
  limit: number = ACTIVITY_LIMIT,
): AgreementRow[] {
  return [...rows]
    .sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0))
    .slice(0, limit);
}

export interface PlanBanner {
  readonly tone: 'plan' | 'limit';
  readonly title: string;
  readonly body: string | null;
  /** M-A12 W1-D.3 — opens the Plans screen: "See plans ›" or, on a paid plan, "Manage plan ›". */
  readonly action: 'See plans' | 'Manage plan';
}

/** M-A12 W1-D.3 — the copy when the monthly sends are used up (signing never counts). */
export const NO_SENDS_LEFT = 'No sends left this month. Signing is always free.';

function bannerAction(account: BillingAccount | null | undefined): PlanBanner['action'] {
  const sub = account?.subscription;
  return sub && sub.source !== 'FREE' && sub.ended_at == null ? 'Manage plan' : 'See plans';
}

/** A BUSINESS tenant's counted monthly allowance (null when unlimited or not subscribed). */
function businessMonth(account: BillingAccount): { limit: number; remaining: number; resetsAt: string | null } | null {
  const a = account.allowance as Record<string, unknown> | undefined;
  if (!a || a['subscribed'] === false || a['unlimited'] === true) return null;
  const limit = typeof a['limit'] === 'number' ? a['limit'] : null;
  const used = typeof a['used'] === 'number' ? a['used'] : null;
  if (limit === null || used === null) return null;
  const remaining = typeof a['remaining'] === 'number' ? a['remaining'] : Math.max(0, limit - used);
  return { limit, remaining, resetsAt: typeof a['period_end'] === 'string' ? a['period_end'] : null };
}

function noSendsLeft(resetsAt: string | null, action: PlanBanner['action']): PlanBanner {
  return {
    tone: 'limit',
    title: NO_SENDS_LEFT,
    body: resetsAt ? `Your allowance resets on ${shortDate(resetsAt)}.` : null,
    action,
  };
}

/**
 * The Home plan banner (M-A4 §2.1; M-A12 W1-D.3 for Personal AND Business). Null for
 * accounts without a counted allowance (unlimited or not subscribed).
 *
 * Copy rules (directive C-3/C-4/C-5 unchanged):
 *   - no monthly sends left: "No sends left this month. Signing is always free." with the
 *     reset date (M-A12 D-1: self-signing never draws on the allowance);
 *   - a daily limit: the existing allowance.ts limit banner (exact local time, never
 *     "tomorrow");
 *   - prototype title "{n} of {limit} free sends left this month" only when the server
 *     reports a monthly window AND the subscription is the Free plan (source FREE);
 *   - "Up to {d} a day." only when the server reports a day window (its limit);
 *   - anything else falls back to the existing allowance chip copy (allowance.ts);
 *   - every banner links to the Plans screen ("See plans ›" / "Manage plan ›").
 */
export function planBanner(account: BillingAccount | null | undefined): PlanBanner | null {
  if (!account) return null;
  const action = bannerAction(account);
  if (account.tenant_kind === 'BUSINESS') {
    const m = businessMonth(account);
    if (!m) return null;
    if (m.remaining <= 0) return noSendsLeft(m.resetsAt, action);
    return {
      tone: 'plan',
      title: `${m.remaining} of ${m.limit} sends left this month`,
      body: 'Signing is always free.',
      action,
    };
  }
  const m = allowanceModel(account);
  if (!m) return null;
  if (m.month && m.month.remaining <= 0) return noSendsLeft(m.resetsAt, action);
  const limit = limitBanner(m);
  if (limit) return { tone: 'limit', title: limit.title, body: limit.body, action };
  const free = account.subscription?.source === 'FREE';
  if (free && m.month) {
    const body: string[] = [];
    if (m.day) body.push(`Up to ${m.day.limit} a day.`);
    body.push('Signing is always free.');
    return {
      tone: 'plan',
      title: `${m.month.remaining} of ${m.month.limit} free sends left this month`,
      body: body.join(' '),
      action,
    };
  }
  return { tone: 'plan', title: allowanceChipText(m), body: null, action };
}

export interface HomeModel {
  readonly welcome: string;
  readonly chips: HomeChip[];
  readonly tasks: AssignedTask[];
  readonly tasksHeading: string;
  readonly activity: AgreementRow[];
  readonly banner: PlanBanner | null;
}

export function homeModel(input: {
  readonly rows: readonly AgreementRow[];
  readonly displayName: string | null | undefined;
  readonly billing: BillingAccount | null | undefined;
  readonly now?: number;
}): HomeModel {
  const tasks = assignedTasks(input.rows, input.now);
  return {
    welcome: welcomeText(input.displayName),
    chips: homeChips(input.rows),
    tasks,
    tasksHeading: tasksHeading(tasks.length),
    activity: recentActivity(input.rows),
    banner: planBanner(input.billing),
  };
}
