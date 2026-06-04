import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { ObjectStorageModule } from '@aramo/object-storage';

import { ResumeParserService } from './resume-parser.service.js';

// A8-3b — ResumeParseModule.
//
// Leaf import set (lint:nx-boundaries):
//   - ObjectStorageModule → ObjectStorageService (presigned-GET for the
//                           parse fetch; the service does NOT hold S3
//                           bytes in memory between requests).
//
// Deliberately NOT imported:
//   - @aramo/talent-record — the prefill is shaped to a structural
//     subset (TalentRecordPrefill in this lib's types) so the consumer
//     edge is one-way: talent-record → resume-parse (the E2 controller
//     in talent-record consumes this service). The inverse import would
//     create a cycle.
//   - @aramo/ai-draft, @anthropic-ai/sdk, any LLM substrate — ADR-0015
//     Decision 10 confines AI consumption to libs/ai-draft. The
//     no-LLM-boundary structural spec (src/tests/no-llm-boundary.spec.ts)
//     enforces this at CI.
@Module({
  imports: [ObjectStorageModule],
  providers: [
    ResumeParserService,
    {
      provide: 'ResumeParserServiceLogger',
      useFactory: () => createAramoLogger(ResumeParserService.name),
    },
  ],
  exports: [ResumeParserService],
})
export class ResumeParseModule {}
