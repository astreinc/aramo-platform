import { Global, Module } from '@nestjs/common';
import { ConsentModule } from '@aramo/consent';
import { RECRUITER_CREATE_CONSENT_DEFAULT } from '@aramo/talent-record';

import { RecruiterCreateConsentDefaultAdapter } from './recruiter-create-consent-default.adapter.js';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 §6 — the ONLY place talent-record's
// RECRUITER_CREATE_CONSENT_DEFAULT port is joined to @aramo/consent, so no new nx
// dependency edge is created between the two libs (mirrors
// ResumeAttachmentResolverModule). @Global so TalentRecordController and
// TalentCreateFromDraftService (declared in TalentRecordModule) can inject the
// STRING token.
@Global()
@Module({
  imports: [ConsentModule],
  providers: [
    RecruiterCreateConsentDefaultAdapter,
    {
      provide: RECRUITER_CREATE_CONSENT_DEFAULT,
      useExisting: RecruiterCreateConsentDefaultAdapter,
    },
  ],
  exports: [RECRUITER_CREATE_CONSENT_DEFAULT],
})
export class RecruiterCreateConsentDefaultModule {}
