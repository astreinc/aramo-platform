// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9, Amendment A1
// §A1.1 — the VENDOR-NEUTRAL outbound messaging port for Aramo Sign (SMS and WhatsApp).
// E-Sign never imports a provider SDK: the composition root (apps/sign-service) binds
// this port to an adapter chosen from the environment (unset = off). A1.1 — tests use
// stubs only; unit tests never call a live vendor.
//
// The message is described by PURPOSE plus named VARIABLES, never as free text, because
// two of the three default vendors only deliver pre-registered templates:
//   - MSG91 (India): every SMS must match a DLT-registered template (TRAI); the template id
//     is mandatory.
//   - Meta WhatsApp Cloud API: business-initiated messages must use a pre-approved template.
//   - AWS End User Messaging SMS (US): free text, rendered by the adapter from the purpose.
// The signing link is a capability URL: adapters pass it to the vendor and NEVER log it.

export const OUTBOUND_MESSAGING_PORT = 'OUTBOUND_MESSAGING_PORT';

export type MessagingChannel = 'SMS' | 'WHATSAPP';
export const MESSAGING_CHANNELS: readonly MessagingChannel[] = ['SMS', 'WHATSAPP'];

/** INVITATION / REMINDER carry the signing link; OTP carries a one-time code. */
export type MessagePurpose = 'INVITATION' | 'REMINDER' | 'OTP';

export interface OutboundMessage {
  channel: MessagingChannel;
  purpose: MessagePurpose;
  /** E.164, validated by the caller (isE164). */
  to_e164: string;
  variables: {
    /** The sender's organization or name, shown so the recipient knows who is asking. */
    sender_name?: string;
    /** INVITATION / REMINDER — the signing link (contains a raw capability token). NEVER logged. */
    signing_url?: string;
    /** OTP — the code. NEVER logged in production. */
    code?: string;
    /** OTP — how long the code is valid, in minutes. */
    ttl_minutes?: number;
  };
  /** Our delivery id, passed to vendors that echo a reference back in status callbacks. */
  reference: string;
}

export type OutboundSendResult =
  | { outcome: 'sent'; provider: string; provider_message_id: string | null }
  /** The vendor says the number opted out (e.g. AWS opt-out list); recorded locally too. */
  | { outcome: 'opted_out'; provider: string }
  | { outcome: 'failed'; provider: string; error_code: string };

export interface OutboundMessagingPort {
  /** The channels with a configured provider. An empty set means messaging is off. */
  readonly channels: ReadonlySet<MessagingChannel>;
  /** True when this channel can send to this number (provider routing, e.g. +91 → MSG91). */
  canSend(channel: MessagingChannel, to_e164: string): boolean;
  send(message: OutboundMessage): Promise<OutboundSendResult>;
}
