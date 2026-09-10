import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { AiDraftModule, STRUCTURED_GENERATION_PROVIDER, type StructuredGenerationProvider } from '@aramo/ai-draft';
import { CommunicationsModule, CommunicationsRepository } from '@aramo/communications';
import { ConsentModule, ConsentService } from '@aramo/consent';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import {
  ConversationTranscriptPrismaService,
  ConversationTranscriptRepository,
} from '@aramo/conversation-transcript';
import {
  AI_PROCESSING_AUTHORIZATION,
  CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
  ConversationIntelligenceModule,
  ConversationIntelligenceProcessingService,
  ConversationIntelligenceRunRepository,
  NORMALIZED_TRANSCRIPT_SOURCE,
  PrismaService as ConversationIntelligencePrismaService,
  REQUISITION_SNAPSHOT_SOURCE,
  RequisitionAnalysisContextSnapshotService,
} from '@aramo/conversation-intelligence';

import { AiProcessingConsentGate } from './ai-processing-consent.gate.js';
import { AnthropicConversationIntelligenceAdapter } from './anthropic-ci-model-provider.adapter.js';
import { CiProcessingConfig } from './ci-processing.config.js';
import { CiProcessingProducer } from './ci-processing.producer.js';
import { CiProcessingProcessor } from './ci-processing.processor.js';
import { CiProcessingReconciler } from './ci-processing-reconciler.js';
import { CI_PROCESSING_QUEUE_NAME } from './ci-processing.queue.constants.js';
import { CiSnapshotResolver } from './ci-snapshot-resolver.js';
import { NormalizedTranscriptReadyHandler } from './normalized-transcript-ready.handler.js';
import { ObjectStorageNormalizedTranscriptSource } from './normalized-transcript-source.adapter.js';
import { B2RequisitionSnapshotSource } from './requisition-snapshot-source.adapter.js';

// CI-B6P §33 — the production CI-processing composition module. Binds every CI
// port to a concrete adapter over the existing authorities, composes the B6
// processing service, and registers the BullMQ worker + producer + reconciler.
//
// DARK BY DEFAULT: CiProcessingConfig gates on CI_PROCESSING_ENABLED (absent →
// disabled). The app boots cleanly with real DI and makes NO model call while
// dark. No test fake is bound in production — the model provider is the
// Anthropic adapter over the ai-draft structured-generation surface.
//
// BullMQ wiring mirrors OfferExpiryModule verbatim (manualRegistration +
// lazyConnect + RedisConnectionConfig factory); the worker's
// onApplicationBootstrap is Redis-gated (silent when REDIS_URL is absent).
@Module({
  imports: [
    CommonModule,
    CommunicationsModule,
    ConsentModule,
    ObjectStorageModule,
    ConversationIntelligenceModule,
    AiDraftModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = { skipWaitingForReady: true, skipVersionCheck: true, skipMetasUpdate: true };
        try {
          return { ...baseOpts, connection: { ...cfg.connection, lazyConnect: true } };
        } catch (err) {
          if (err instanceof Error && err.message === 'REDIS_URL is not configured') {
            return { ...baseOpts, connection: { host: '127.0.0.1', port: 6379, lazyConnect: true } };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: CI_PROCESSING_QUEUE_NAME }),
  ],
  providers: [
    CiProcessingConfig,
    // --- CI run persistence (conversation_intelligence schema) ---
    ConversationIntelligencePrismaService,
    ConversationIntelligenceRunRepository,
    // --- transcript read (B4 artifact) ---
    ConversationTranscriptPrismaService,
    {
      provide: ConversationTranscriptRepository,
      useFactory: (prisma: ConversationTranscriptPrismaService) => new ConversationTranscriptRepository(prisma),
      inject: [ConversationTranscriptPrismaService],
    },
    // --- CI ports bound to concrete adapters ---
    {
      provide: NORMALIZED_TRANSCRIPT_SOURCE,
      useFactory: (repo: ConversationTranscriptRepository, storage: ObjectStorageService) =>
        new ObjectStorageNormalizedTranscriptSource(repo, storage),
      inject: [ConversationTranscriptRepository, ObjectStorageService],
    },
    {
      provide: AI_PROCESSING_AUTHORIZATION,
      useFactory: (comms: CommunicationsRepository, consent: ConsentService) =>
        new AiProcessingConsentGate(comms, consent),
      inject: [CommunicationsRepository, ConsentService],
    },
    {
      provide: REQUISITION_SNAPSHOT_SOURCE,
      useFactory: (snapshots: RequisitionAnalysisContextSnapshotService) =>
        new B2RequisitionSnapshotSource(snapshots),
      inject: [RequisitionAnalysisContextSnapshotService],
    },
    {
      provide: CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
      useFactory: (generation: StructuredGenerationProvider, config: CiProcessingConfig) =>
        new AnthropicConversationIntelligenceAdapter(generation, config),
      inject: [STRUCTURED_GENERATION_PROVIDER, CiProcessingConfig],
    },
    // --- processing service (ports injected by token above) ---
    {
      provide: ConversationIntelligenceProcessingService,
      useFactory: (
        repo: ConversationIntelligenceRunRepository,
        snapshots: B2RequisitionSnapshotSource,
        transcripts: ObjectStorageNormalizedTranscriptSource,
        authz: AiProcessingConsentGate,
        model: AnthropicConversationIntelligenceAdapter,
      ) => new ConversationIntelligenceProcessingService(repo, snapshots, transcripts, authz, model),
      inject: [
        ConversationIntelligenceRunRepository,
        REQUISITION_SNAPSHOT_SOURCE,
        NORMALIZED_TRANSCRIPT_SOURCE,
        AI_PROCESSING_AUTHORIZATION,
        CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
      ],
    },
    // --- scheduling + queue + worker + recovery ---
    CiSnapshotResolver,
    CiProcessingProducer,
    NormalizedTranscriptReadyHandler,
    CiProcessingReconciler,
    CiProcessingProcessor,
    {
      provide: 'NormalizedTranscriptReadyHandlerLogger',
      useFactory: () => createAramoLogger(NormalizedTranscriptReadyHandler.name),
    },
    {
      provide: 'CiProcessingReconcilerLogger',
      useFactory: () => createAramoLogger(CiProcessingReconciler.name),
    },
    {
      provide: 'CiProcessingProcessorLogger',
      useFactory: () => createAramoLogger(CiProcessingProcessor.name),
    },
  ],
  exports: [NormalizedTranscriptReadyHandler, ConversationIntelligenceProcessingService],
})
export class CiProcessingModule {}
