import type { EsignLifecycleEvent } from './lifecycle-event.js';

// E-Sign OC v2 — the outbound webhook-delivery boundary. The E-Sign delivery
// worker hands a generic lifecycle event to this port; the composition root binds
// the HMAC-signed HTTPS adapter (apps/esign-service). Delivery is E-Sign-owned
// (Independent-Digital-Signature-Platform Directive sections 8, 28): the port
// reports success/failure so the outbox can persist attempt/backoff state.

export const WEBHOOK_DELIVERY_PORT = 'WEBHOOK_DELIVERY_PORT';

export interface WebhookDeliveryResult {
  ok: boolean;
  // Bounded, sanitized short diagnostic on failure (never a raw response body).
  error_code?: string;
}

export interface WebhookDeliveryPort {
  deliver(event: EsignLifecycleEvent): Promise<WebhookDeliveryResult>;
}
