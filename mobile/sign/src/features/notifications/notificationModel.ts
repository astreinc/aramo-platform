// Notification feed model (handoff §4.7; directive §8; M-A3 §1). Pure.
// Sender items carry `envelope_id` and open the sender detail on its Activity tab.
// Recipient items carry `inbox_item_id` (envelope_id is null — the sender's id is never
// exposed to a recipient) and open the received view.
import type { SignPaths } from '../../api/types';
import type { RootStackParamList } from '../../navigation/types';

type FeedResponse = NonNullable<
  SignPaths['/v1/sign/me/notifications']['get']['responses'][200]['content']['application/json']
>;
export type FeedItem = FeedResponse['items'][number];
export type FeedType = FeedItem['type'];

export const FEED_TYPES: readonly FeedType[] = [
  'SIGNED',
  'VIEWED',
  'DECLINED',
  'SIGNATURE_NEEDED',
  'COMPLETED',
  'EXPIRED',
  'REMINDER',
];

export type NotificationTarget =
  | { readonly name: 'EnvelopeDetail'; readonly params: RootStackParamList['EnvelopeDetail'] }
  | { readonly name: 'ReceivedEnvelope'; readonly params: RootStackParamList['ReceivedEnvelope'] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** Where a feed row or push opens. Sender → detail (Activity); recipient → inbox item. */
export function targetFor(ref: {
  readonly envelope_id?: string | null;
  readonly inbox_item_id?: string | null;
}): NotificationTarget | null {
  if (isUuid(ref.envelope_id))
    return {
      name: 'EnvelopeDetail',
      params: { envelopeId: ref.envelope_id.toLowerCase(), initialTab: 'activity' },
    };
  if (isUuid(ref.inbox_item_id))
    return { name: 'ReceivedEnvelope', params: { inboxItemId: ref.inbox_item_id.toLowerCase() } };
  return null;
}

export function titleFor(item: Pick<FeedItem, 'type' | 'actor_name'>): string {
  const who = item.actor_name?.trim() || 'Someone';
  switch (item.type) {
    case 'SIGNED':
      return `${who} signed`;
    case 'VIEWED':
      return `${who} viewed`;
    case 'DECLINED':
      return `${who} declined`;
    case 'SIGNATURE_NEEDED':
      return 'Waiting for your signature';
    case 'COMPLETED':
      return 'Everyone signed';
    case 'EXPIRED':
      return 'Link expired';
    case 'REMINDER':
      return 'Your signature is still needed';
    default:
      return 'Agreement updated';
  }
}

export type FeedIcon = 'signed' | 'viewed' | 'declined' | 'expired' | 'completed' | 'needs';

export function iconFor(type: FeedType): FeedIcon {
  switch (type) {
    case 'SIGNED':
      return 'signed';
    case 'VIEWED':
      return 'viewed';
    case 'DECLINED':
      return 'declined';
    case 'EXPIRED':
      return 'expired';
    case 'COMPLETED':
      return 'completed';
    default:
      return 'needs';
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Today / Earlier (a client concern, M-A3 §1), newest first as the server sends them. */
export function sections(
  items: readonly FeedItem[],
  now: Date = new Date(),
): { title: 'Today' | 'Earlier'; data: FeedItem[] }[] {
  const today: FeedItem[] = [];
  const earlier: FeedItem[] = [];
  for (const i of items) (sameLocalDay(new Date(i.created_at), now) ? today : earlier).push(i);
  const out: { title: 'Today' | 'Earlier'; data: FeedItem[] }[] = [];
  if (today.length) out.push({ title: 'Today', data: today });
  if (earlier.length) out.push({ title: 'Earlier', data: earlier });
  return out;
}

/** Mark one item read in a cached page list (the server is the authority; this mirrors it). */
export function withRead<T extends { items: readonly FeedItem[] }>(
  pages: readonly T[],
  id: string,
  at: string,
): T[] {
  return pages.map((p) => ({
    ...p,
    items: p.items.map((i) => (i.id === id && !i.read_at ? { ...i, read_at: at } : i)),
  }));
}

export function withAllRead<T extends { items: readonly FeedItem[] }>(
  pages: readonly T[],
  at: string,
): T[] {
  return pages.map((p) => ({
    ...p,
    items: p.items.map((i) => (i.read_at ? i : { ...i, read_at: at })),
  }));
}
