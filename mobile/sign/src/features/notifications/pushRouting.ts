// Push tap routing (directive §8; M-A2 §4; M-A3 §2). A push payload's data is ONLY
// `{ type, envelope_id }` (sender) or `{ type, inbox_item_id }` (claimed recipient): no
// capability token, no link, no document content. Anything else is ignored. A push
// always opens an authenticated screen; unclaimed received envelopes are reachable only
// from the email link.
import { FEED_TYPES, targetFor, type FeedType, type NotificationTarget } from './notificationModel';

export function routeForPushData(data: unknown): NotificationTarget | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d['type'] !== 'string' || !FEED_TYPES.includes(d['type'] as FeedType)) return null;
  const envelopeId = d['envelope_id'];
  const inboxItemId = d['inbox_item_id'];
  // Exactly one reference: a payload naming both is malformed.
  const hasEnvelope = typeof envelopeId === 'string' && envelopeId !== '';
  const hasInbox = typeof inboxItemId === 'string' && inboxItemId !== '';
  if (hasEnvelope === hasInbox) return null;
  return targetFor({
    envelope_id: hasEnvelope ? (envelopeId as string) : null,
    inbox_item_id: hasInbox ? (inboxItemId as string) : null,
  });
}
