import { Global, Module } from '@nestjs/common';
import { SubmittalModule } from '@aramo/submittal';
import { SUBMITTED_HISTORY_PORT } from '@aramo/reporting';

import { SubmittedHistoryAdapter } from './submitted-history.adapter.js';

// Lane 2 / L2-E (SB-5) — binds the reporting SubmittedHistoryPort token to the
// @aramo/submittal-backed adapter at the composition root. @Global so ReportingService
// (instantiated inside libs/reporting's ReportingModule, which cannot import
// @aramo/submittal) can resolve the token without libs/reporting gaining a submittal
// import. This module — NOT libs/reporting — owns the submittal dependency.
@Global()
@Module({
  imports: [SubmittalModule],
  providers: [
    SubmittedHistoryAdapter,
    { provide: SUBMITTED_HISTORY_PORT, useExisting: SubmittedHistoryAdapter },
  ],
  exports: [SUBMITTED_HISTORY_PORT],
})
export class SubmittedHistoryModule {}
