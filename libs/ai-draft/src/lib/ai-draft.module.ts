import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { AiDraftRepository } from './ai-draft.repository.js';
import { AiDraftService } from './ai-draft.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { DRAFT_PROVIDER_TOKEN } from './providers/tokens.js';
import { SecretCacheService } from './secrets/secret-cache.service.js';
import { AnthropicStructuredGenerationService } from './structured-generation/anthropic-structured-generation.service.js';
import { STRUCTURED_GENERATION_PROVIDER } from './structured-generation/structured-generation.types.js';

// libs/ai-draft module — M5 PR-5 substrate. Per ADR-0015 + Ruling 11
// (Process Lesson 45): imports = [] because CommonModule.exports content
// (verified at audit time: only RequestIdMiddleware) is not required by
// any provider in this module. AramoError + AramoLogger are TS-level
// imports, NOT Nest providers, so no module import is needed for them.
//
// Exports = [AiDraftService] only — DraftProvider, AnthropicProvider,
// SecretCacheService, and AiDraftRepository are internal to the module.
// Future consumers (M5 PR-6+ selection drafting) consume AiDraftService
// at the cross-lib boundary.
//
// Logger discipline (HK-PR-4 Style A): two named tokens
// (AiDraftServiceLogger, AiDraftRepositoryLogger) registered via
// useFactory. The Anthropic provider and secret-cache do not currently
// take a logger; their observability flows through the service layer.

@Module({
  imports: [],
  providers: [
    PrismaService,
    AiDraftRepository,
    SecretCacheService,
    { provide: DRAFT_PROVIDER_TOKEN, useClass: AnthropicProvider },
    // CI-B6P — reusable structured-generation surface (owns the Anthropic SDK
    // client, reuses SecretCacheService). Exported for the CI composition root.
    { provide: STRUCTURED_GENERATION_PROVIDER, useClass: AnthropicStructuredGenerationService },
    AiDraftService,
    {
      provide: 'AiDraftServiceLogger',
      useFactory: () => createAramoLogger(AiDraftService.name),
    },
    {
      provide: 'AiDraftRepositoryLogger',
      useFactory: () => createAramoLogger(AiDraftRepository.name),
    },
  ],
  // TENANT-LLM-1 — SecretCacheService is exported so the admin set/rotate/clear
  // path (apps/api tenant-llm) can invalidate THIS singleton's per-tenant cache
  // immediately after a key write (rotation-correctness). It remains internal to
  // the LLM call path otherwise.
  exports: [AiDraftService, STRUCTURED_GENERATION_PROVIDER, SecretCacheService],
})
export class AiDraftModule {}
