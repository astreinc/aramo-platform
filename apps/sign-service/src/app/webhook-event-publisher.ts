import { createHmac } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { canonicalSignEventType, SignWebhookRepository, type EsignLifecycleEvent, type WebhookDeliveryPort, type WebhookDeliveryResult } from '@aramo/sign';

// E-Sign OC v2 — canonical outbound lifecycle-event delivery (Independent-Digital-
// Signature-Platform Directive sections 9, 12, 13B). Delivers the GENERIC event to
// the Core consumer-owned receiver over an HMAC-signed HTTPS webhook.
//
// The signature is HMAC-SHA256 over `${timestamp}.${rawBody}` where rawBody is the
// EXACT byte string POSTed (never a re-serialized object) — so Core verifies the
// bytes it actually received and can reject replays outside the timestamp window.
// Events carry ids only; the raw signing capability token never appears here.
export function computeEsignWebhookSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('base64');
}

// Sign Unified Product S-5 (directive §4.4.4) — routing. An envelope's events go
// to the webhook SUBSCRIPTIONS of its installation (and, for a first-party
// application, its application-level subscriptions): the event is fanned out into
// one delivery row per subscription (SignWebhookDeliveryService delivers them,
// each signed with that subscription's own secret). The legacy single target and
// shared secret below remain ONLY for ATS envelopes while the ATS has no
// subscription (S-6 migrates it); envelopes of any other application with no
// subscription are not delivered anywhere.
export const LEGACY_WEBHOOK_APPLICATION = 'aramo-ats';

@Injectable()
export class HttpWebhookEventPublisher implements WebhookDeliveryPort {
  constructor(@Optional() private readonly webhooks?: SignWebhookRepository) {}

  async deliver(event: EsignLifecycleEvent): Promise<WebhookDeliveryResult> {
    if (this.webhooks !== undefined) {
      const { envelope, subscriptions } = await this.webhooks.subscriptionsForEnvelope(event.tenant_id, event.envelope_id);
      if (subscriptions.length > 0) {
        const matching = subscriptions.filter((s) => s.event_types.length === 0 || s.event_types.includes(canonicalSignEventType(event.event_type)));
        await this.webhooks.enqueue(
          matching.map((s) => ({
            subscription_id: s.id,
            event_id: event.event_id,
            tenant_id: event.tenant_id,
            envelope_id: event.envelope_id,
            event_type: event.event_type,
            payload: event as unknown as object,
          })),
        );
        return { ok: true };
      }
      if (envelope !== null && envelope.source_application !== LEGACY_WEBHOOK_APPLICATION) return { ok: true };
    }
    return this.deliverLegacy(event);
  }

  private targetUrl(): string {
    const explicit = process.env['SIGN_WEBHOOK_TARGET_URL'];
    if (explicit !== undefined && explicit !== '') return explicit;
    const base = process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
    return `${base}/v1/integrations/sign/events`;
  }

  private async deliverLegacy(event: EsignLifecycleEvent): Promise<WebhookDeliveryResult> {
    const secret = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    // Fail-closed: never deliver unsigned. The row stays unpublished and retries.
    if (secret === undefined || secret === '') return { ok: false, error_code: 'NO_SIGNING_SECRET' };

    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeEsignWebhookSignature(timestamp, rawBody, secret);
    try {
      const res = await fetch(this.targetUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aramo-sign-timestamp': timestamp,
          'x-aramo-sign-signature': signature,
        },
        body: rawBody,
      });
      if (res.ok) return { ok: true };
      return { ok: false, error_code: `HTTP_${res.status}` };
    } catch {
      return { ok: false, error_code: 'NETWORK' };
    }
  }
}
