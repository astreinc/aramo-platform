import type { Logger } from '@nestjs/common';

// Aramo-Sign-Remaining-Work-Consolidated-Directive-v1_0-LOCKED §3 B9 — one log shape for every
// vendor webhook sign-service receives, so the production probe (deploy/monitoring/
// aramo-health-probe.sh, MON_RE_SIGN_WEBHOOK) can alert on it with one pattern:
//
//   sign_webhook.rejected source=<source> reason=<REASON>   the request failed authentication
//   sign_webhook.failed source=<source> error=<ErrorName>     an authentic request could not be
//                                                            processed (the vendor redelivers)
//
// Only the source, the reason code and the error class are logged: never a body, a header, a
// phone number or a message (they may carry personal data or secrets).

// M-A12 W1-G — the in-app store notifications (App Store Server Notifications v2, Google RTDN).
export type SignWebhookSource = 'whatsapp' | 'sms_inbound_aws' | 'stripe_identity' | 'stripe_connect' | 'stripe_billing' | 'app_store_billing' | 'google_play_billing';

const token = (v: string): string => (v.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown');

export function logWebhookRejected(logger: Pick<Logger, 'warn'>, source: SignWebhookSource, reason: string): void {
  logger.warn(`sign_webhook.rejected source=${source} reason=${token(reason)}`);
}

export function logWebhookFailed(logger: Pick<Logger, 'warn'>, source: SignWebhookSource, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  logger.warn(`sign_webhook.failed source=${source} error=${token(name)}`);
}
