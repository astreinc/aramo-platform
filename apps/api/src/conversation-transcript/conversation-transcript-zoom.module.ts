// CI-B5Z — the production composition module. It OWNS the wiring the B3/B4 libs
// deliberately left to the composition root: binds the transcript ports
// (INTERACTION_REFERENCE_PORT, TRANSCRIPT_ARTIFACT_STORE, the correlator, the
// consent gate) to concrete adapters over the existing Communications / Consent
// / Integration / ObjectStorage authorities, composes the B3 acquisition + B4
// normalization services, and registers the Zoom Phone recording-transcript
// provider + WEBVTT parser EXACTLY ONCE. No new domain ownership, no new message
// bus, no test fake in production.

import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { CommunicationsModule, CommunicationsRepository } from '@aramo/communications';
import { ConsentModule } from '@aramo/consent';
import { IntegrationModule } from '@aramo/integration';
import { ConsentService } from '@aramo/consent';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import {
  ConversationTranscriptProviderRegistry,
  ConversationTranscriptRepository,
  ConversationTranscriptService,
  ConversationTranscriptPrismaService,
  INTERACTION_REFERENCE_PORT,
  TRANSCRIPT_ARTIFACT_STORE,
  TranscriptNormalizationService,
  TranscriptSourceParserRegistry,
  type InteractionReferencePort,
  type TranscriptArtifactStore,
} from '@aramo/conversation-transcript';

import { ZOOM_TRANSCRIPT_EVENT_HANDLER } from '../communications/zoom-transcript-event-handler.port.js';

import { ZoomTranscriptEventHandlerAdapter } from './zoom-transcript-event-handler.adapter.js';
import { ObjectStorageTranscriptArtifactStore } from './object-storage-transcript-artifact-store.adapter.js';
import { CommunicationsInteractionReferenceReader, CommunicationsTranscriptCorrelator } from './transcript-interaction-correlator.adapter.js';
import { ConsentTranscriptGate } from './consent-transcript.gate.js';
import { ZoomRecordingTranscriptProvider } from './zoom/zoom-recording-transcript.provider.js';
import { ZoomVttTranscriptParser } from './zoom/zoom-vtt.parser.js';
import { ZoomTranscriptHttpClient, type FetchLike } from './zoom/zoom-transcript-http.client.js';
import { IntegrationZoomConnectionSecretResolver, SecretsManagerZoomTokenProvider } from './zoom/zoom-transcript-resolvers.js';
import {
  TRANSCRIPT_CONSENT_GATE,
  TRANSCRIPT_INTERACTION_CORRELATOR,
  ZoomRecordingTranscriptOrchestrator,
  type TranscriptConsentGate,
  type TranscriptInteractionCorrelator,
} from './zoom/zoom-recording-transcript.orchestrator.js';

const ZOOM_TRANSCRIPT_PROVIDER = 'ZOOM_TRANSCRIPT_PROVIDER_INSTANCE';
const ZOOM_TRANSCRIPT_PARSER = 'ZOOM_TRANSCRIPT_PARSER_INSTANCE';

/** Registers the Zoom provider + WEBVTT parser into the (empty) registries once. */
@Injectable()
class ZoomTranscriptRegistrar implements OnApplicationBootstrap {
  constructor(
    private readonly providerRegistry: ConversationTranscriptProviderRegistry,
    private readonly parserRegistry: TranscriptSourceParserRegistry,
    @Inject(ZOOM_TRANSCRIPT_PROVIDER) private readonly provider: ZoomRecordingTranscriptProvider,
    @Inject(ZOOM_TRANSCRIPT_PARSER) private readonly parser: ZoomVttTranscriptParser,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.providerRegistry.has(this.provider.providerKey())) {
      this.providerRegistry.register(this.provider);
    }
    if (!this.parserRegistry.has(this.parser.formatKey())) {
      this.parserRegistry.register(this.parser);
    }
  }
}

@Module({
  imports: [CommunicationsModule, ConsentModule, IntegrationModule, ObjectStorageModule],
  providers: [
    // --- B3/B4 substrate, composed at the root with ports bound ---
    ConversationTranscriptPrismaService,
    ConversationTranscriptProviderRegistry,
    TranscriptSourceParserRegistry,
    {
      provide: ConversationTranscriptRepository,
      useFactory: (prisma: ConversationTranscriptPrismaService) => new ConversationTranscriptRepository(prisma),
      inject: [ConversationTranscriptPrismaService],
    },
    {
      provide: INTERACTION_REFERENCE_PORT,
      useFactory: (repo: CommunicationsRepository): InteractionReferencePort => new CommunicationsInteractionReferenceReader(repo),
      inject: [CommunicationsRepository],
    },
    {
      provide: TRANSCRIPT_ARTIFACT_STORE,
      useFactory: (storage: ObjectStorageService): TranscriptArtifactStore => new ObjectStorageTranscriptArtifactStore(storage),
      inject: [ObjectStorageService],
    },
    {
      provide: ConversationTranscriptService,
      useFactory: (repo: ConversationTranscriptRepository, reg: ConversationTranscriptProviderRegistry, iref: InteractionReferencePort) =>
        new ConversationTranscriptService(repo, reg, iref),
      inject: [ConversationTranscriptRepository, ConversationTranscriptProviderRegistry, INTERACTION_REFERENCE_PORT],
    },
    {
      provide: TranscriptNormalizationService,
      useFactory: (repo: ConversationTranscriptRepository, preg: TranscriptSourceParserRegistry, store: TranscriptArtifactStore) =>
        new TranscriptNormalizationService(repo, preg, store),
      inject: [ConversationTranscriptRepository, TranscriptSourceParserRegistry, TRANSCRIPT_ARTIFACT_STORE],
    },
    // --- Zoom recording-transcript adapter chain ---
    IntegrationZoomConnectionSecretResolver,
    SecretsManagerZoomTokenProvider,
    {
      provide: ZoomTranscriptHttpClient,
      useFactory: (tokens: SecretsManagerZoomTokenProvider) =>
        new ZoomTranscriptHttpClient(tokens, ((url, init) => fetch(url, init as RequestInit)) as FetchLike),
      inject: [SecretsManagerZoomTokenProvider],
    },
    {
      provide: ZOOM_TRANSCRIPT_PROVIDER,
      useFactory: (client: ZoomTranscriptHttpClient, store: TranscriptArtifactStore, conn: IntegrationZoomConnectionSecretResolver) =>
        new ZoomRecordingTranscriptProvider(client, store, conn),
      inject: [ZoomTranscriptHttpClient, TRANSCRIPT_ARTIFACT_STORE, IntegrationZoomConnectionSecretResolver],
    },
    { provide: ZOOM_TRANSCRIPT_PARSER, useClass: ZoomVttTranscriptParser },
    // --- correlation + consent enforcement ---
    {
      provide: TRANSCRIPT_INTERACTION_CORRELATOR,
      useFactory: (repo: CommunicationsRepository): TranscriptInteractionCorrelator => new CommunicationsTranscriptCorrelator(repo),
      inject: [CommunicationsRepository],
    },
    {
      provide: TRANSCRIPT_CONSENT_GATE,
      useFactory: (repo: CommunicationsRepository, consent: ConsentService): TranscriptConsentGate => new ConsentTranscriptGate(repo, consent),
      inject: [CommunicationsRepository, ConsentService],
    },
    // --- orchestrator ---
    {
      provide: ZoomRecordingTranscriptOrchestrator,
      useFactory: (
        correlator: TranscriptInteractionCorrelator,
        consent: TranscriptConsentGate,
        transcripts: ConversationTranscriptService,
        normalizer: TranscriptNormalizationService,
      ) => new ZoomRecordingTranscriptOrchestrator(correlator, consent, transcripts, normalizer),
      inject: [TRANSCRIPT_INTERACTION_CORRELATOR, TRANSCRIPT_CONSENT_GATE, ConversationTranscriptService, TranscriptNormalizationService],
    },
    ZoomTranscriptRegistrar,
    // Webhook seam: bind the loosely-coupled handler token to the orchestrator.
    {
      provide: ZOOM_TRANSCRIPT_EVENT_HANDLER,
      useFactory: (orchestrator: ZoomRecordingTranscriptOrchestrator) =>
        new ZoomTranscriptEventHandlerAdapter(orchestrator),
      inject: [ZoomRecordingTranscriptOrchestrator],
    },
  ],
  exports: [ZoomRecordingTranscriptOrchestrator, ZOOM_TRANSCRIPT_EVENT_HANDLER],
})
export class ConversationTranscriptZoomModule {}
