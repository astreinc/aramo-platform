// DOC-3 §298 — E-Sign depends on this delivery abstraction; the composition root
// (apps/esign-service) binds it to SES MailerPort / Microsoft Graph. E-Sign MUST
// NOT import provider SDKs. A provider outage is a RETRYABLE delivery condition,
// never a corrupt envelope.

export const SIGNING_NOTIFICATION_PORT = 'SIGNING_NOTIFICATION_PORT';

export type SigningNotificationKind =
  | 'SIGNATURE_REQUEST'
  | 'SIGNATURE_REMINDER'
  | 'SIGNATURE_COMPLETED'
  | 'SIGNATURE_DECLINED'
  | 'SIGNATURE_EXPIRED';

export interface SigningNotification {
  kind: SigningNotificationKind;
  to_email: string;
  to_name: string;
  envelope_subject: string;
  // The signing link (contains the raw capability token) — NEVER logged.
  signing_url?: string;
}

export interface SigningNotificationResult {
  delivered: boolean;
  provider_message_id?: string;
}

export interface SigningNotificationPort {
  notify(input: SigningNotification): Promise<SigningNotificationResult>;
}
