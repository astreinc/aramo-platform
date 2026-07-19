// Auth-Decoupling PR-2 (ADR-0021 §2 — auth defines the ports; Aramo implements
// the adapters). Auth's OWN transactional-email port. Auth depends on NOTHING
// Aramo (R-P23-1): this token + interface live in auth territory, and an Aramo
// adapter (MailerEmailSenderAdapter) delegates to @aramo/mailer's MailerPort.
//
// The shape MIRRORS @aramo/mailer's SendEmailInput / SendEmailResult EXACTLY
// (R-P23-2) — same fields, same optionality, same result — so the adapter is a
// pure pass-through and behaviour is preserved by construction. Do NOT "improve"
// the interface here.
export const EMAIL_SENDER = 'EMAIL_SENDER';

export interface EmailSenderInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSenderResult {
  message_id: string;
}

export interface EmailSender {
  send(args: EmailSenderInput): Promise<EmailSenderResult>;
}
