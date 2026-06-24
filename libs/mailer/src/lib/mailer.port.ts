// Email-S1 §1.1 — MailerPort: Aramo's GENERIC transactional-email port.
//
// This is deliberately NOT invite-specific. S2's invite + acceptance-
// confirmation emails plug into it; future transactional mail (password
// reset, notifications) reuses the same port. Template rendering is a
// CALLER concern — the port takes PRE-RENDERED html/text and sends.
//
// The FROM-address is NOT a caller parameter. It is fixed adapter config
// (support@aramo.ai, from SES_FROM_ADDRESS env) so no caller can ever
// choose the sender. See SesMailerAdapter / loadMailerConfig.

export interface SendEmailInput {
  // Recipient address. S1 sends to a single recipient; multi-recipient /
  // cc / bcc are out of scope until a caller needs them.
  to: string;
  subject: string;
  // Pre-rendered HTML body. The port does not template — the caller
  // supplies final markup.
  html: string;
  // Optional plaintext fallback (multipart alternative). Omit to send
  // HTML-only.
  text?: string;
}

export interface SendEmailResult {
  // The provider-assigned message id (SES MessageId for the real adapter;
  // a synthetic id for the stub). Surfaced for log correlation.
  message_id: string;
}

export interface MailerPort {
  send(args: SendEmailInput): Promise<SendEmailResult>;
}
