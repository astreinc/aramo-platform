import type { AuthContextType } from '@aramo/auth';

// COMM-C2B — the contacting-consent gate for outbound email (R17). The email
// service depends on this port; the concrete adapter wraps the existing
// ConsentService (operation=communication, channel=email). A denial (or an
// error) fails closed and produces NO email evidence.

export const EMAIL_CONSENT_GATE = 'EMAIL_CONSENT_GATE';

export interface EmailContactRequest {
  readonly tenant_id: string;
  readonly talent_record_id: string;
  readonly authContext: AuthContextType;
  readonly requestId: string;
}

export class EmailConsentDeniedError extends Error {
  constructor(readonly reason: 'denied' | 'error' = 'denied') {
    super(`email contact not permitted by consent (${reason})`);
    this.name = 'EmailConsentDeniedError';
  }
}

export interface EmailConsentGate {
  /** Throws EmailConsentDeniedError unless contacting-by-email is permitted. */
  assertEmailContactAllowed(req: EmailContactRequest): Promise<void>;
}
