import { Injectable } from '@nestjs/common';
import { ConsentService } from '@aramo/consent';

import {
  EmailConsentDeniedError,
  type EmailConsentGate,
  type EmailContactRequest,
} from './email-consent-gate.port.js';

// COMM-C2B — real contacting-consent gate for email (R17). Reuses the existing
// ConsentService operative check (operation=communication → `contacting` scope,
// channel=email). Fail-closed: anything other than an explicit `allowed`
// decision blocks the send.
@Injectable()
export class ConsentEmailGateAdapter implements EmailConsentGate {
  constructor(private readonly consent: ConsentService) {}

  async assertEmailContactAllowed(req: EmailContactRequest): Promise<void> {
    const decision = await this.consent.check(
      { talent_record_id: req.talent_record_id, operation: 'communication', channel: 'email' },
      undefined,
      req.authContext,
      req.requestId,
    );
    if (decision.result !== 'allowed') {
      throw new EmailConsentDeniedError(decision.result === 'error' ? 'error' : 'denied');
    }
  }
}
