// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED) — the composition-
// root adapter for talent-record's RECRUITER_CREATE_CONSENT_DEFAULT port. Delegates
// to the SOLE consent authority (ConsentService.recordRecruiterCreateDefault →
// the one writer recordConsentEvent). No second writer, no direct ledger write.
// Errors propagate; the talent-record caller owns the §5 fail-soft.

import { Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { ConsentService } from '@aramo/consent';
import type { RecruiterCreateConsentDefaultPort } from '@aramo/talent-record';

@Injectable()
export class RecruiterCreateConsentDefaultAdapter
  implements RecruiterCreateConsentDefaultPort
{
  constructor(private readonly consent: ConsentService) {}

  async recordDefault(input: {
    talent_record_id: string;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<void> {
    await this.consent.recordRecruiterCreateDefault({
      talent_record_id: input.talent_record_id,
      authContext: input.authContext,
      requestId: input.requestId,
    });
  }
}
