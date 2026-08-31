import { Global, Module } from '@nestjs/common';
import { ClientSelectionModule } from '@aramo/client-selection';
import { INTERVIEW_HISTORY_PORT } from '@aramo/reporting';

import { InterviewHistoryAdapter } from './interview-history.adapter.js';

// Lane 2 / L2-I (D4b) — binds the reporting InterviewHistoryPort token to the
// @aramo/client-selection-backed adapter at the composition root. @Global so ReportingService
// (instantiated inside libs/reporting's ReportingModule, which cannot import
// @aramo/client-selection — the A7 seam) can resolve the token without libs/reporting gaining a
// client-selection import. This module — NOT libs/reporting — owns the client-selection
// dependency. Mirrors the L2-E SubmittedHistoryModule.
@Global()
@Module({
  imports: [ClientSelectionModule],
  providers: [
    InterviewHistoryAdapter,
    { provide: INTERVIEW_HISTORY_PORT, useExisting: InterviewHistoryAdapter },
  ],
  exports: [INTERVIEW_HISTORY_PORT],
})
export class InterviewHistoryModule {}
