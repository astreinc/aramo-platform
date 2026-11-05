// M-A12 W1-D.1 — the Tasks screen (prototype "Tasks"): received envelopes that need the
// user now (Needs me: inbox `can_sign`, never an email match) and later in the order
// (Upcoming: W2 `my_status` 'upcoming'), with a filter and a sort. Pure; built only from
// the merged Agreements rows the app already loads.
import { needsMe, relativeTime, shortDate, upcoming, type AgreementRow } from '../inbox/agreementsModel';
import type { InboxItem } from '../inbox/types';

export type TaskFilter = 'all' | 'needs_me' | 'upcoming';
export type TaskSort = 'newest' | 'oldest' | 'sender';

export const TASK_FILTERS: readonly { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_me', label: 'Needs me' },
  { key: 'upcoming', label: 'Upcoming' },
];

export const TASK_SORTS: readonly { key: TaskSort; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'sender', label: 'Sender A–Z' },
];

export interface TaskCard {
  readonly key: string;
  readonly inboxItemId: string;
  readonly kind: 'needs_me' | 'upcoming';
  readonly subject: string;
  /** "From {sender} · {when}". */
  readonly subtitle: string;
  /** "Link expires {date}" when the server says so. */
  readonly due: string | null;
  readonly sentAt: string;
  readonly from: string;
}

export interface TasksModel {
  readonly needs: readonly TaskCard[];
  readonly upcoming: readonly TaskCard[];
  readonly summary: string;
  readonly empty: boolean;
}

function card(row: Extract<AgreementRow, { kind: 'received' }>, kind: TaskCard['kind'], now: number): TaskCard {
  const i: InboxItem = row.item;
  const from = i.from ?? '';
  const when = relativeTime(i.sent_at, now);
  const head = from ? `From ${from}` : 'Received';
  const expires = i.envelope_expires_at ?? i.expires_at ?? null;
  return {
    key: row.key,
    inboxItemId: row.inboxItemId,
    kind,
    subject: row.subject,
    subtitle: when ? `${head} · ${when}` : head,
    due: expires ? `Link expires ${shortDate(expires)}` : null,
    sentAt: i.sent_at ?? row.activityAt,
    from,
  };
}

export function sortTasks(cards: readonly TaskCard[], sort: TaskSort): TaskCard[] {
  const out = [...cards];
  if (sort === 'sender')
    return out.sort((a, b) => a.from.localeCompare(b.from, undefined, { sensitivity: 'base' }) || (a.sentAt < b.sentAt ? 1 : -1));
  const dir = sort === 'oldest' ? 1 : -1;
  return out.sort((a, b) => (a.sentAt < b.sentAt ? -dir : a.sentAt > b.sentAt ? dir : 0));
}

export function tasksModel(
  rows: readonly AgreementRow[],
  filter: TaskFilter,
  sort: TaskSort,
  now: number = Date.now(),
): TasksModel {
  const needs: TaskCard[] = [];
  const later: TaskCard[] = [];
  for (const r of rows) {
    if (r.kind !== 'received') continue;
    if (needsMe(r)) needs.push(card(r, 'needs_me', now));
    else if (upcoming(r)) later.push(card(r, 'upcoming', now));
  }
  const shownNeeds = filter === 'upcoming' ? [] : sortTasks(needs, sort);
  const shownLater = filter === 'needs_me' ? [] : sortTasks(later, sort);
  const n = needs.length;
  return {
    needs: shownNeeds,
    upcoming: shownLater,
    summary:
      n > 0
        ? `${n} ${n === 1 ? 'agreement is' : 'agreements are'} waiting for your signature`
        : 'Nothing needs your signature right now.',
    empty: shownNeeds.length === 0 && shownLater.length === 0,
  };
}
