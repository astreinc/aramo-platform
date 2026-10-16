import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { TalentExtractionModule } from '@aramo/talent-extraction';
import {
  TalentRecordModule,
  TalentIntakeExtractionService,
  TalentIntakeMessageHandler,
  TALENT_INTAKE_PROCESSING_PORT,
} from '@aramo/talent-record';

import { LlmProviderResolutionModule } from '../tenant-llm/llm-provider-resolution.module.js';

// ADR-0033 — the Talent Intake CONSUMER composition (bootstrapped by the Lambda
// entrypoint). Binds TALENT_INTAKE_PROCESSING_PORT → the runtime-neutral
// extraction service and provides the runtime-neutral message handler. Contains
// NO AWS/SQS/EventBridge, and — critically — NO publisher/drain worker, so the
// Lambda consumer can never become a second outbox publisher. The SQS→Lambda
// adapter lives OUTSIDE Nest (in the entrypoint) and only calls the exported
// handler with a validated envelope.
// LlmProviderResolutionModule (TENANT-LLM-2): this module is the root of the
// out-of-AppModule intake contexts (singlebox worker + redrive via
// TalentIntakeWorkerModule, and the SQS Lambda handler). Without it the ai-draft
// dispatchers' @Optional ACTIVE_PROVIDER_RESOLVER is absent and résumé
// extraction silently ran on Anthropic for every tenant, ignoring
// llm.active_provider (§2.1 / §4.1 — no cross-provider fallback).
@Module({
  imports: [CommonModule, TalentRecordModule, TalentExtractionModule, LlmProviderResolutionModule],
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
