import { Global, Module } from '@nestjs/common';
import { INTERVIEWER_VALIDATOR } from '@aramo/client-selection';
import { IdentityCoreModule } from '@aramo/identity';

import { IdentityInterviewerValidator } from './interviewer-validator.adapter.js';

// Slice B (Calendar/Interview §9) — binds the lib's INTERVIEWER_VALIDATOR port to the
// IdentityService-backed adapter. @Global so the ClientSelectionController (declared in the
// client-selection lib module) can resolve the token without the lib importing identity.
// IdentityCoreModule is the SHARED identity READ surface (no invite/lifecycle ports).
@Global()
@Module({
  imports: [IdentityCoreModule],
  providers: [
    IdentityInterviewerValidator,
    { provide: INTERVIEWER_VALIDATOR, useClass: IdentityInterviewerValidator },
  ],
  exports: [INTERVIEWER_VALIDATOR],
})
export class InterviewerValidatorModule {}
