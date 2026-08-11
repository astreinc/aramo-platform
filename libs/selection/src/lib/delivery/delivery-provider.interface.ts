// M5 PR-6 §4.3 — DeliveryProvider port (Ruling 3 Q7-Stub).
//
// Outreach-send substrate accepts an injected DeliveryProvider adapter.
// PR-6 ships exactly one implementation: SendStubDeliveryProvider
// (in-process no-op that records a synthetic delivery_id). Real SES /
// SendGrid implementations are explicitly out-of-scope per directive §5
// and ADR-0015 (substrate is delivery-vendor-agnostic at the port layer;
// the adapter is the only vendor-specific surface).
//
// The port mirrors the libs/ai-draft DraftProvider design (M5 PR-5 §4.5):
// a single async method that takes a typed input record + returns a
// typed result record. Vendor-specific error translation, retries,
// rate-limit handling are adapter concerns.

export interface DeliveryInput {
  // The redacted completion text returned by AiDraftService.generateDraft.
  // The substrate guarantees this is post-redaction (no raw PII).
  completion: string;
  // Closed-list delivery channel discriminant. PR-6 only emits 'email';
  // future channel additions require directive amendment.
  delivery_channel: 'email';
  // Tenant scope for the delivery. Adapters may use this for per-tenant
  // routing (e.g., SES configuration sets), audit tagging, or rate-limit
  // bucketing.
  tenant_id: string;
  // Request-id thread for cross-system correlation (X-Request-ID header
  // → AramoLogger → adapter logs).
  requestId: string;
  // Optional recipient handle. PR-6 substrate does not resolve recipient
  // identity from TalentContactMethod (deferred per Ruling 7) — the
  // caller may supply a literal handle for stub correlation only.
  recipient_handle?: string;
}

export interface DeliveryResult {
  delivered: true;
  delivered_at: Date;
  delivery_id: string;
  delivery_channel: 'email';
}

export interface DeliveryProvider {
  deliver(input: DeliveryInput): Promise<DeliveryResult>;
}
