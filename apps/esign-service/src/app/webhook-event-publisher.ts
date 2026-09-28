import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { EsignLifecycleEvent, WebhookDeliveryPort, WebhookDeliveryResult } from '@aramo/esign';

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

@Injectable()
export class HttpWebhookEventPublisher implements WebhookDeliveryPort {
  private targetUrl(): string {
    const explicit = process.env['ESIGN_WEBHOOK_TARGET_URL'];
    if (explicit !== undefined && explicit !== '') return explicit;
    const base = process.env['DOCUMENTS_API_URL'] ?? 'http://localhost:3000';
    return `${base}/v1/integrations/esign/events`;
  }

  async deliver(event: EsignLifecycleEvent): Promise<WebhookDeliveryResult> {
    const secret = process.env['ESIGN_WEBHOOK_SIGNING_SECRET'];
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
          'x-aramo-esign-timestamp': timestamp,
          'x-aramo-esign-signature': signature,
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
