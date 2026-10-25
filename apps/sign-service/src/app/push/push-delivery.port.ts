import type { PushData, PushText } from '@aramo/sign';

// Aramo Sign Mobile — PUSH_DELIVERY_PORT (M-A3 §2; directive §8, B-4). One port,
// adapters per provider: `disabled` (default), `log`, `apns` (token-based HTTP/2)
// and `fcm` (HTTP v1). SIGN_PUSH_DELIVERY selects them: `disabled`, `log`, or a
// comma list of providers (`apns`, `fcm`, `apns,fcm`).
//
// A message carries the lock-screen text, the badge and the data { type,
// envelope_id } (or { type, inbox_item_id } for a recipient) — never a capability
// token, a link or document content. The provider token is passed in clear only to
// send() and is never logged.

export const PUSH_DELIVERY_PORT = 'PUSH_DELIVERY_PORT';

export type PushProvider = 'apns' | 'fcm';

export interface PushMessage extends PushText {
  data: PushData;
  badge?: number;
}

export type PushSendResult =
  | { outcome: 'sent' }
  // The provider says the token is no longer valid: the device is pruned.
  | { outcome: 'unregistered'; error_code: string }
  // Transient (throttled, provider unavailable, network): retried with backoff.
  | { outcome: 'retry'; error_code: string }
  // Permanent for this message (bad request, misconfiguration): not retried.
  | { outcome: 'failed'; error_code: string };

export interface PushDeliveryPort {
  // The providers this binding can deliver to. Empty = push is off: no push job is
  // enqueued (the feed is still written).
  readonly providers: ReadonlySet<PushProvider>;
  send(provider: PushProvider, token: string, message: PushMessage): Promise<PushSendResult>;
}
