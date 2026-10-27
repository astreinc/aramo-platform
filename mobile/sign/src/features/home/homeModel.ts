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
//   Plan banner    — Personal only (allowance.ts returns null otherwise); copy rules below
import { countFor, needsMe, relativeTime, type AgreementRow } from '../inbox/agreementsModel';
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
}

/**
 * The Personal plan banner (M-A4 §2.1). Null for Business tenants and for Personal
 * accounts without a counted allowance (allowanceModel returns null for those).
 *
 * Copy rules (directive C-3/C-4/C-5 unchanged):
 *   - at a limit: the existing allowance.ts limit banner (exact local time, never
 *     "tomorrow"; resets on {date});
 *   - prototype title "{n} of {limit} free sends left this month" only when the server
 *     reports a monthly window AND the subscription is the Free plan (source FREE), so
 *     both the count and the word "free" come from the server;
 *   - "Up to {d} a day." only when the server reports a day window (its limit);
 *   - "Signing is always free." only on that same Free plan: the server's allowance counts
 *     envelopes SENT only (C-4), so signing never draws on it;
 *   - anything else falls back to the existing allowance chip copy (allowance.ts).
 */
export function planBanner(account: BillingAccount | null | undefined): PlanBanner | null {
  const m = allowanceModel(account);
  if (!m) return null;
  const limit = limitBanner(m);
  if (limit) return { tone: 'limit', title: limit.title, body: limit.body };
  const free = account?.subscription?.source === 'FREE';
  if (free && m.month) {
    const body: string[] = [];
    if (m.day) body.push(`Up to ${m.day.limit} a day.`);
    body.push('Signing is always free.');
    return {
      tone: 'plan',
      title: `${m.month.remaining} of ${m.month.limit} free sends left this month`,
      body: body.join(' '),
    };
  }
  return { tone: 'plan', title: allowanceChipText(m), body: null };
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
