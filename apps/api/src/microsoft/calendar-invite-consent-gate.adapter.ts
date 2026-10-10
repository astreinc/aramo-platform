import { Injectable } from '@nestjs/common';
import { ConsentService } from '@aramo/consent';

import {
  CalendarInviteConsentDeniedError,
  type CalendarInviteConsentGate,
  type CalendarInviteContactRequest,
} from './calendar-invite-consent-gate.port.js';

// COMM-C2B Amendment A1 (M365-SCHED-1, R1) — real contacting-consent gate for an
// Outlook calendar invitation. Reuses the existing ConsentService operative check
// (operation=communication → `contacting` scope, channel=email — the invitation is
// delivered to the Talent by email). Fail-closed: anything other than an explicit
// `allowed` decision (missing, stale, invalid, or error) blocks the invitation.
@Injectable()
export class ConsentCalendarInviteGateAdapter implements CalendarInviteConsentGate {
  constructor(private readonly consent: ConsentService) {}

  async assertInvitationAllowed(req: CalendarInviteContactRequest): Promise<void> {
    const decision = await this.consent.check(
      { talent_record_id: req.talent_record_id, operation: 'communication', channel: 'email' },
      undefined,
      req.authContext,
      req.requestId,
    );
    if (decision.result !== 'allowed') {
      throw new CalendarInviteConsentDeniedError(decision.result === 'error' ? 'error' : 'denied');
    }
  }
}
