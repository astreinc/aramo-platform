import type { AuthContextType } from '@aramo/auth';

// COMM-C2B Amendment A1 (M365-SCHED-1, R1) — the contacting-consent gate for an
// Outlook calendar INVITATION. A calendar invitation addressed to a Talent is an
// outbound Talent-contact action, so the scheduling service depends on this port
// and must pass it BEFORE the provider transmits an invitation. The concrete
// adapter reuses the ratified ConsentService check (operation=communication →
// `contacting`). A denial, stale/invalid consent, or an error fails closed and NO
// invitation is transmitted. The create-link-only path does NOT use this gate — it
// sends no invitation and keeps its no-contact semantics.

export const CALENDAR_INVITE_CONSENT_GATE = 'CALENDAR_INVITE_CONSENT_GATE';

export interface CalendarInviteContactRequest {
  readonly tenant_id: string;
  readonly talent_record_id: string;
  readonly authContext: AuthContextType;
  readonly requestId: string;
}

export class CalendarInviteConsentDeniedError extends Error {
  constructor(readonly reason: 'denied' | 'error' = 'denied') {
    super(`calendar invitation not permitted by consent (${reason})`);
    this.name = 'CalendarInviteConsentDeniedError';
  }
}

export interface CalendarInviteConsentGate {
  /** Throws CalendarInviteConsentDeniedError unless contacting the Talent is permitted. */
  assertInvitationAllowed(req: CalendarInviteContactRequest): Promise<void>;
}
