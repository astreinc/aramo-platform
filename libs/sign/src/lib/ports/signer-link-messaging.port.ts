// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 — the hook through
// which a freshly issued signing link is ALSO delivered by SMS or WhatsApp when the sender
// chose that channel for the recipient. Called after the email path, with the same raw
// link (never stored, never logged). The composition root binds it to the Sign messaging
// service; unbound = email only (today's behaviour). The implementation decides
// everything else (feature availability, opt-out, quiet hours, rate limits, ledger) and
// never throws into the caller: a messaging failure never fails a send or a reminder.

export const SIGNER_LINK_MESSAGING_PORT = 'SIGNER_LINK_MESSAGING_PORT';

export interface SignerLinkMessage {
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  purpose: 'INVITATION' | 'REMINDER';
  /** Contains a raw capability token — NEVER logged or persisted. */
  signing_url: string;
}

export interface SignerLinkMessagingPort {
  deliverSigningLink(message: SignerLinkMessage): Promise<void>;
}
