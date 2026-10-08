import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { TalentExtractionModule } from '@aramo/talent-extraction';
import {
  TalentRecordModule,
  TalentIntakeExtractionService,
  TalentIntakeMessageHandler,
  TALENT_INTAKE_PROCESSING_PORT,
} from '@aramo/talent-record';

// ADR-0033 — the Talent Intake CONSUMER composition (bootstrapped by the Lambda
// entrypoint). Binds TALENT_INTAKE_PROCESSING_PORT → the runtime-neutral
// extraction service and provides the runtime-neutral message handler. Contains
// NO AWS/SQS/EventBridge, and — critically — NO publisher/drain worker, so the
// Lambda consumer can never become a second outbox publisher. The SQS→Lambda
// adapter lives OUTSIDE Nest (in the entrypoint) and only calls the exported
// handler with a validated envelope.
@Module({
  imports: [CommonModule, TalentRecordModule, TalentExtractionModule],
  providers: [
    TalentIntakeExtractionService,
    {
      provide: 'TalentIntakeExtractionServiceLogger',
      useFactory: () => createAramoLogger(TalentIntakeExtractionService.name),
    },
    { provide: TALENT_INTAKE_PROCESSING_PORT, useExisting: TalentIntakeExtractionService },
    TalentIntakeMessageHandler,
    {
      provide: 'TalentIntakeMessageHandlerLogger',
      useFactory: () => createAramoLogger(TalentIntakeMessageHandler.name),
    },
  ],
  exports: [TalentIntakeMessageHandler, TALENT_INTAKE_PROCESSING_PORT],
})
export class TalentIntakeConsumerModule {}
