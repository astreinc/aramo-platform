import { Module } from '@nestjs/common';
import {
  AiDraftModule,
  ACTIVE_EMBEDDING_PROVIDER_RESOLVER,
  EMBEDDING_PORT,
  OpenAiEmbeddingProvider,
} from '@aramo/ai-draft';
import { ConsentModule } from '@aramo/consent';
import { SettingsModule } from '@aramo/settings';
import { TalentEmbeddingModule } from '@aramo/talent-embedding';
import { TalentRecordModule } from '@aramo/talent-record';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { RequisitionModule } from '@aramo/requisition';
import { CompanyModule } from '@aramo/company';

import { EmbeddingProcessingConfig } from './embedding-processing.config.js';
import { RequisitionEmbeddingLifecycleService } from './requisition-embedding-lifecycle.service.js';
import { RequisitionEmbeddingWorker } from './requisition-embedding.worker.js';
import { CompanyEmbeddingLifecycleService } from './company-embedding-lifecycle.service.js';
import { CompanyEmbeddingWorker } from './company-embedding.worker.js';
import { SettingsActiveEmbeddingProviderResolver } from './settings-active-embedding-provider.resolver.js';
import { TalentEmbeddingConsentGate } from './talent-embedding-consent.gate.js';
import { TALENT_EMBEDDING_CONSENT_PORT } from './talent-embedding-consent.port.js';
import { TalentEmbeddingFactsAdapter } from './talent-embedding-facts.adapter.js';
import { TALENT_EMBEDDING_FACTS_PORT } from './talent-embedding-facts.port.js';
import { TalentEmbeddingLifecycleService } from './talent-embedding-lifecycle.service.js';
import { TalentEmbeddingReconcileService } from './talent-embedding-reconcile.service.js';
import { TalentEmbeddingWorker } from './talent-embedding.worker.js';

// Enterprise Search GS-2 P2/P4 + GS-2A — the embedding boundary for apps/api. Imports:
//   AiDraftModule (SecretCacheService — tenant BYO key custody + the EMBEDDING_PORT provider deps),
//   SettingsModule (active-embedding-provider selection), ConsentModule (P4 ai_processing gate),
//   TalentEmbeddingModule (the pgvector repository behind TALENT_EMBEDDING_REPOSITORY_PORT +
//     TALENT_EMBEDDING_SEARCH_PORT), and TalentRecord/TalentEvidence modules (facts-adapter deps).
// The worker is DARK by default (EmbeddingProcessingConfig / EMBEDDING_PROCESSING_ENABLED). Consumers
// depend on the ports, never the OpenAI adapter, the vendor SDK, ConsentService, or the repository.
@Module({
  imports: [
    AiDraftModule,
    SettingsModule,
    ConsentModule,
    TalentEmbeddingModule,
    TalentRecordModule,
    TalentEvidenceModule,
    // GS-2B — the requisition schema owns RequisitionEmbeddingRepository (lifecycle + OR-union retrieval).
    RequisitionModule,
    // GS-2C — the company schema owns CompanyEmbeddingRepository (lifecycle + visibility-set retrieval).
    CompanyModule,
  ],
  providers: [
    {
      provide: ACTIVE_EMBEDDING_PROVIDER_RESOLVER,
      useClass: SettingsActiveEmbeddingProviderResolver,
    },
    { provide: EMBEDDING_PORT, useClass: OpenAiEmbeddingProvider },
    { provide: TALENT_EMBEDDING_CONSENT_PORT, useClass: TalentEmbeddingConsentGate },
    { provide: TALENT_EMBEDDING_FACTS_PORT, useClass: TalentEmbeddingFactsAdapter },
    EmbeddingProcessingConfig,
    TalentEmbeddingLifecycleService,
    TalentEmbeddingReconcileService,
    TalentEmbeddingWorker,
    // GS-2B requisition embedding (no consent gate — directive ruling 2).
    RequisitionEmbeddingLifecycleService,
    RequisitionEmbeddingWorker,
    // GS-2C company embedding (no consent gate — companies are not Talent-consent subjects).
    CompanyEmbeddingLifecycleService,
    CompanyEmbeddingWorker,
  ],
  exports: [
    EMBEDDING_PORT,
    TALENT_EMBEDDING_CONSENT_PORT,
    TalentEmbeddingWorker,
    // The dark reconcile sweep + worker, consumed by the BullMQ processor module.
    TalentEmbeddingReconcileService,
    // GS-2B requisition worker, consumed by the same BullMQ processor tick.
    RequisitionEmbeddingWorker,
    // GS-2C company worker, consumed by the same BullMQ processor tick.
    CompanyEmbeddingWorker,
    // Exported so the GS-2A/GS-2B/GS-2C search adapters can dark-gate their semantic legs.
    EmbeddingProcessingConfig,
  ],
})
export class EmbeddingModule {}
