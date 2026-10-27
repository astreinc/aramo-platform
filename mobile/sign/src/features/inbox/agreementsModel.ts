// Agreements list model (handoff §2A, §4.2; M-A4 §3; directive §7 C-12). Pure: merges
// the sender list (GET /v1/sign/sender/envelopes) with the recipient inbox
// (GET /v1/sign/inbox) and any local-only Send-flow drafts into one list, then filters it
// into All · Needs me · Waiting for others · Drafts · Completed, and by last activity.
//
//   All      — every row
//   Needs me — received items the server says the user can sign now (`can_sign`)
//   Waiting  — every other open envelope: sent ones in SENT / IN_PROGRESS, and received
//              ones still open where the user has finished their part
//   Drafts   — the user's DRAFT envelopes (server drafts + local drafts not yet synced)
//   Completed ('done') — the end states COMPLETED · DECLINED · VOIDED · EXPIRED (sent and
//              received), labelled "Completed" (M-A4 §3.1)
//
// All 7 statuses render (SENT included). Sorting is latest activity first; search
// matches the subject. The last-activity range (M-A4 §3.2) is applied HERE, on the
// device, over the rows already loaded: the server's `days` filters by creation date.
import type { LocalDraft } from '../../state/draftStore';
import {
  END_STATUSES,
  OPEN_STATUSES,
  type EnvelopeStatus,
  type InboxItem,
  type InboxList,
  type SenderListItem,
} from './types';

export type AgreementRow =
  | {
      readonly kind: 'sent';
      readonly key: string;
      readonly envelopeId: string;
      readonly subject: string;
      readonly status: EnvelopeStatus;
      readonly activityAt: string;
      readonly item: SenderListItem;
    }
  | {
      readonly kind: 'received';
      readonly key: string;
      readonly inboxItemId: string;
      readonly subject: string;
      readonly status: EnvelopeStatus;
      readonly activityAt: string;
      readonly item: InboxItem;
    }
  | {
      readonly kind: 'local-draft';
      readonly key: string;
      readonly localDraftId: string;
      readonly subject: string;
      readonly status: 'DRAFT';
      readonly activityAt: string;
    };

/** The status filter (a superset of the navigation AgreementsFilter; mapped at the screen). */
export type ListFilter = 'all' | 'needs_me' | 'waiting' | 'drafts' | 'done';
/** Last activity range, applied on the device (M-A4 §3.2). */
export type ListRange = '30d' | '6m' | '12m' | 'all';

export const FILTERS: readonly ListFilter[] = ['all', 'needs_me', 'waiting', 'drafts', 'done'];

/** Chip labels (handoff §2A "Status chips"). */
export const FILTER_LABEL: Record<ListFilter, string> = {
  all: 'All',
  needs_me: 'Needs me',
  waiting: 'Waiting for others',
  drafts: 'Drafts',
  done: 'Completed',
};

/** The filter name in the header row and the filter sheet. */
export const FILTER_HEADING: Record<ListFilter, string> = {
  ...FILTER_LABEL,
  all: 'All agreements',
};

export const RANGES: readonly ListRange[] = ['30d', '6m', '12m', 'all'];

export const RANGE_LABEL: Record<ListRange, string> = {
  '30d': 'Last 30 days',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  all: 'All time',
};

/** Days back from now per range (the prototype's cut-offs); null = no limit. */
const RANGE_DAYS: Record<ListRange, number | null> = {
  '30d': 30,
  '6m': 183,
  '12m': 366,
  all: null,
};

/** The prototype opens Agreements on "Last 6 months". */
export const DEFAULT_RANGE: ListRange = '6m';

export function asListFilter(v: unknown): ListFilter | undefined {
  return typeof v === 'string' && (FILTERS as readonly string[]).includes(v)
    ? (v as ListFilter)
    : undefined;
}

export function asListRange(v: unknown): ListRange | undefined {
  return typeof v === 'string' && (RANGES as readonly string[]).includes(v)
    ? (v as ListRange)
    : undefined;
}

/** Header row text: "{filter} · {range}" (e.g. "All agreements · Last 6 months"). */
export function listHeading(filter: ListFilter, range: ListRange): string {
  return `${FILTER_HEADING[filter]} · ${RANGE_LABEL[range]}`;
}

/** Whether the row's last activity falls inside the range. */
export function inRange(row: AgreementRow, range: ListRange, now: number = Date.now()): boolean {
  const days = RANGE_DAYS[range];
  if (days === null) return true;
  const t = Date.parse(row.activityAt);
  return Number.isNaN(t) || t >= now - days * 86_400_000;
}

export const EMPTY_STATE: Record<ListFilter | 'search' | 'range', { title: string; body: string }> =
  {
    all: { title: 'No agreements yet', body: 'Agreements you send or receive show up here.' },
    needs_me: {
      title: 'You’re all caught up',
      body: 'Nothing needs your signature right now.',
    },
    waiting: {
      title: 'Nothing waiting on others',
      body: 'Envelopes you send show up here until everyone signs.',
    },
    drafts: { title: 'No drafts', body: 'Envelopes you save for later show up here.' },
    done: {
      title: 'Nothing finished yet',
      body: 'Completed, declined and expired envelopes show up here.',
    },
    search: { title: 'No matches', body: 'Try a different search.' },
    range: { title: 'Nothing here', body: 'Try another status or a longer time range.' },
  };

function latest(...isos: (string | null | undefined)[]): string {
  let best = '';
  for (const v of isos) if (v && v > best) best = v;
  return best || new Date(0).toISOString();
}

function inboxItems(inbox: InboxList | null | undefined): InboxItem[] {
  if (!inbox) return [];
  const seen = new Set<string>();
  const out: InboxItem[] = [];
  for (const i of [...(inbox.waiting ?? []), ...(inbox.completed ?? []), ...(inbox.other ?? [])]) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

/** Interleave sent, received and local-only drafts into one list, newest activity first. */
export function mergeAgreements(
  sent: readonly SenderListItem[] | null | undefined,
  inbox: InboxList | null | undefined,
  localDrafts: readonly LocalDraft[] = [],
): AgreementRow[] {
  const rows: AgreementRow[] = [];
  for (const e of sent ?? []) {
    rows.push({
      kind: 'sent',
      key: `s:${e.id}`,
      envelopeId: e.id,
      subject: e.subject,
      status: e.status,
      activityAt: latest(e.last_activity_at, e.completed_at, e.sent_at, e.created_at),
      item: e,
    });
  }
  for (const i of inboxItems(inbox)) {
    rows.push({
      kind: 'received',
      key: `r:${i.id}`,
      inboxItemId: i.id,
      subject: i.subject,
      status: i.envelope_status,
      activityAt: latest(i.completed_at, i.signed_at, i.sent_at),
      item: i,
    });
  }
  for (const d of localDrafts) {
    // A draft that already has a server envelope is listed from the server.
    if (d.envelopeId !== null) continue;
    rows.push({
      kind: 'local-draft',
      key: `l:${d.localId}`,
      localDraftId: d.localId,
      subject: draftSubject(d),
      status: 'DRAFT',
      activityAt: d.updatedAt,
    });
  }
  return rows.sort((a, b) =>
    a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0,
  );
}

function draftSubject(d: LocalDraft): string {
  const p = d.payload as { subject?: unknown } | null;
  return typeof p?.subject === 'string' && p.subject.trim() ? p.subject : 'Untitled draft';
}

export function needsMe(row: AgreementRow): boolean {
  return row.kind === 'received' && row.item.can_sign;
}

export function matchesFilter(row: AgreementRow, filter: ListFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_me':
      return needsMe(row);
    case 'waiting':
      return !needsMe(row) && OPEN_STATUSES.has(row.status);
    case 'drafts':
      return row.status === 'DRAFT' && row.kind !== 'received';
    case 'done':
      return END_STATUSES.has(row.status);
  }
}

export function matchesSearch(row: AgreementRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || row.subject.toLowerCase().includes(q);
}

export function filterAgreements(
  rows: readonly AgreementRow[],
  filter: ListFilter,
  query = '',
  range: ListRange = 'all',
  now: number = Date.now(),
): AgreementRow[] {
  return rows.filter(
    (r) => matchesFilter(r, filter) && matchesSearch(r, query) && inRange(r, range, now),
  );
}

export function countFor(rows: readonly AgreementRow[], filter: ListFilter): number {
  return rows.filter((r) => matchesFilter(r, filter)).length;
}

/** The pill a row shows: "Sign now" when it needs the user, else its status (all 7). */
export function pillFor(row: AgreementRow): EnvelopeStatus | 'NEEDS_ME' {
  return needsMe(row) ? 'NEEDS_ME' : row.status;
}

/**
 * The status line under the subject (handoff §2A "Status line copy"; M-A4 §3.4).
 * Sent rows may name signers from the sender list. Received rows NEVER name or count
 * other recipients (A8/A9; directive C-6, §4.6): only the sender organization and the
 * user's own part.
 */
export function secondaryLine(row: AgreementRow): string {
  if (row.kind === 'local-draft') return 'Draft · not sent · saved on this phone';
  if (row.kind === 'received') {
    const i = row.item;
    if (i.can_sign)
      return i.from ? `Needs your signature · from ${i.from}` : 'Needs your signature';
    switch (i.envelope_status) {
      case 'COMPLETED':
        return 'Completed';
      case 'DECLINED':
        return i.my_status === 'DECLINED' ? 'You declined' : 'Declined';
      case 'VOIDED':
        return 'Voided';
      case 'EXPIRED':
        return 'Expired';
      default:
        if (i.my_status === 'SIGNED') return 'You signed · waiting for others';
        return i.from ? `From ${i.from}` : 'Received';
    }
  }
  const e = row.item;
  const signers = e.recipients;
  const signed = signers.filter((s) => s.status === 'SIGNED').length;
  switch (e.status) {
    case 'DRAFT':
      return 'Draft · not sent';
    case 'COMPLETED': {
      // The list carries no per-signer signed_at, so "the last signer" is only known when
      // there is exactly one signer; otherwise the line stays "Completed" (Gap, see report).
      const only = signers.length === 1 ? signers[0] : undefined;
      return only ? `Completed by ${only.name}` : 'Completed';
    }
    case 'DECLINED': {
      const by = signers.find((s) => s.status === 'DECLINED');
      return by ? `Declined by ${by.name}` : 'Declined by a signer';
    }
    case 'EXPIRED':
      return 'Expired';
    case 'VOIDED':
      return 'Voided';
    default:
      return `Waiting for others · ${signed} of ${signers.length} signed`;
  }
}

/** Status icon (handoff §2A "Agreement row"): what the leading icon shows. */
export type StatusIcon = 'needs' | 'waiting' | 'draft' | 'completed' | 'stopped' | 'expired';

export function statusIcon(row: AgreementRow): StatusIcon {
  if (needsMe(row)) return 'needs';
  switch (row.status) {
    case 'DRAFT':
      return 'draft';
    case 'COMPLETED':
      return 'completed';
    case 'DECLINED':
    case 'VOIDED':
      return 'stopped';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'waiting';
  }
}

/** Leading-tile tone (handoff §4.2): needs me tint, completed green, declined red, else fill. */
export function tileTone(row: AgreementRow): 'needs' | 'completed' | 'declined' | 'other' {
  if (needsMe(row)) return 'needs';
  if (row.status === 'COMPLETED') return 'completed';
  if (row.status === 'DECLINED') return 'declined';
  return 'other';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** now / 5m / 3h / 2d / Oct 12 (handoff §4.2). */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  const d = new Date(t);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** "Oct 12, 2026" (local). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Oct 12, 2026, 3:05 PM" (local) — exact times, never "tomorrow" (C-3). */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${shortDate(iso)}, ${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The newest received envelope that needs the user (needs-signature card). */
export function needsSignatureSummary(rows: readonly AgreementRow[]): {
  count: number;
  newest: Extract<AgreementRow, { kind: 'received' }> | null;
} {
  const needs = rows.filter(
    (r): r is Extract<AgreementRow, { kind: 'received' }> => r.kind === 'received' && needsMe(r),
  );
  return { count: needs.length, newest: needs[0] ?? null };
}
