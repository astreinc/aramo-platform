// Agreements list model (handoff §4.2; directive §7 C-12). Pure: merges the sender list
// (GET /v1/sign/sender/envelopes) with the recipient inbox (GET /v1/sign/inbox) and any
// local-only Send-flow drafts into one list, then filters it into
// Needs me / Waiting / Drafts / Done.
//
//   Needs me — received items the server says the user can sign now (`can_sign`)
//   Waiting  — every other open envelope: sent ones in SENT / IN_PROGRESS, and received
//              ones still open where the user has finished their part
//   Drafts   — the user's DRAFT envelopes (server drafts + local drafts not yet synced)
//   Done     — the end states COMPLETED · DECLINED · VOIDED · EXPIRED (sent and received),
//              labelled "Completed" (M-A4 §3.1)
//   All      — every row
//
// All 7 statuses render (SENT included). Sorting is latest activity first; search
// matches the subject.
import type { AgreementsFilter } from '../../navigation/types';
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

export const FILTERS: readonly AgreementsFilter[] = [
  'all',
  'needs_me',
  'waiting',
  'drafts',
  'done',
];

export const FILTER_LABEL: Record<AgreementsFilter, string> = {
  all: 'All',
  needs_me: 'Needs me',
  waiting: 'Waiting for others',
  drafts: 'Drafts',
  done: 'Completed',
};

export const EMPTY_STATE: Record<AgreementsFilter | 'search', { title: string; body: string }> = {
  all: { title: 'Nothing here', body: 'Envelopes you send or receive show up here.' },
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

export function matchesFilter(row: AgreementRow, filter: AgreementsFilter): boolean {
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
  filter: AgreementsFilter,
  query = '',
): AgreementRow[] {
  return rows.filter((r) => matchesFilter(r, filter) && matchesSearch(r, query));
}

export function countFor(rows: readonly AgreementRow[], filter: AgreementsFilter): number {
  return rows.filter((r) => matchesFilter(r, filter)).length;
}

/** The pill a row shows: "Sign now" when it needs the user, else its status (all 7). */
export function pillFor(row: AgreementRow): EnvelopeStatus | 'NEEDS_ME' {
  return needsMe(row) ? 'NEEDS_ME' : row.status;
}

/** The secondary line under the subject (handoff §4.2 "Row"). */
export function secondaryLine(row: AgreementRow): string {
  if (row.kind === 'local-draft') return 'Not sent · saved on this phone';
  if (row.kind === 'received') {
    const i = row.item;
    if (i.can_sign) return 'Needs your signature';
    const from = i.from ? `From ${i.from}` : 'Received';
    switch (i.envelope_status) {
      case 'COMPLETED':
        return 'All signed';
      case 'DECLINED':
        return `${from} · declined`;
      case 'VOIDED':
        return `${from} · voided`;
      case 'EXPIRED':
        return 'Link expired';
      default:
        return i.my_status === 'SIGNED' ? 'You signed · waiting on others' : from;
    }
  }
  const e = row.item;
  const signers = e.recipients;
  const signed = signers.filter((s) => s.status === 'SIGNED').length;
  switch (e.status) {
    case 'DRAFT':
      return 'Not sent';
    case 'COMPLETED':
      return 'All signed';
    case 'DECLINED': {
      const by = signers.find((s) => s.status === 'DECLINED');
      return by ? `by ${by.name}` : 'Declined';
    }
    case 'EXPIRED':
      return 'Link expired';
    case 'VOIDED':
      return 'Voided';
    default:
      return `${signed} of ${signers.length} signed`;
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
