// DOC-3 §298 — E-Sign depends on this delivery abstraction; the composition root
// (apps/sign-service) binds it to SES MailerPort / Microsoft Graph. E-Sign MUST
// NOT import provider SDKs. A provider outage is a RETRYABLE delivery condition,
// never a corrupt envelope.

export const SIGNING_NOTIFICATION_PORT = 'SIGNING_NOTIFICATION_PORT';

export type SigningNotificationKind =
  | 'SIGNATURE_REQUEST'
  | 'SIGNATURE_REMINDER'
  | 'SIGNATURE_COMPLETED'
  | 'SIGNATURE_DECLINED'
  | 'SIGNATURE_EXPIRED'
  | 'SIGNATURE_VOIDED'
  // Multi-Signer M-3b — the sender's progress notice: a signer has signed (not the last).
  | 'SIGNER_SIGNED';

// Who the notification is for: a signer (recipient) or the envelope's sender.
export type SigningNotificationAudience = 'SIGNER' | 'SENDER';

export interface SigningNotification {
  kind: SigningNotificationKind;
  // Defaults to SIGNER.
  audience?: SigningNotificationAudience;
  to_email: string;
  to_name: string;
  envelope_subject: string;
  // The signing link (contains the raw capability token) — NEVER logged.
  signing_url?: string;
  // Signer's signed-copy download link (contains a raw access token) — NEVER logged.
  download_url?: string;
  // Sender's link to the envelope in the Sign console (authenticated; no token).
  console_url?: string;
  // Decline / void reason, shown to the sender (decline) or recipients (void).
  reason?: string;
  // SIGNER_SIGNED — who signed and the progress (display only).
  signer_name?: string;
  signed_count?: number;
  signer_count?: number;
  // SIGNER_SIGNED in a SEQUENTIAL envelope — who is invited next.
  next_signer_name?: string;
}

export interface SigningNotificationResult {
  delivered: boolean;
  provider_message_id?: string;
}

export interface SigningNotificationPort {
  notify(input: SigningNotification): Promise<SigningNotificationResult>;
}
