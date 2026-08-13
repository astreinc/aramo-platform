// Email-S1 §1.1 — DI token for the MailerPort.
//
// Injected via @Inject(MAILER_PORT) wherever transactional email is sent.
// Mirrors the libs/selection DELIVERY_PROVIDER_TOKEN pattern (the
// ports-and-adapters STYLE), but the mailer is a SEPARATE, generic port —
// NOT the selection DeliveryProvider (that is selection-delivery, a
// different seam with its own redaction/consent semantics).
export const MAILER_PORT = 'MAILER_PORT';
