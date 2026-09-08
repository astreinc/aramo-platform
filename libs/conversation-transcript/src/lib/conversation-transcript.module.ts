import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { ConversationTranscriptRepository } from './conversation-transcript.repository.js';
import { ConversationTranscriptService } from './conversation-transcript.service.js';
import { ConversationTranscriptProviderRegistry } from './provider/conversation-transcript-provider.registry.js';
import { TranscriptNormalizationService } from './normalization/transcript-normalization.service.js';
import { TranscriptSourceParserRegistry } from './normalization/transcript-source-parser.registry.js';

// ConversationTranscriptModule — CI-B3 provider-neutral transcript substrate.
//
// Boring, explicit composition: each concrete implementation is bound exactly
// ONCE. The ConversationTranscriptProviderRegistry ships EMPTY (no adapter
// registered in B3; Zoom = CI-B5Z, Teams = CI-B5M). The InteractionReferencePort
// (INTERACTION_REFERENCE_PORT) is intentionally NOT bound here — it is a
// composition-root concern (apps/api reads communications legally). This module
// exposes NO controller/route (internal substrate; no API surface in B3) and is
// NOT imported into the api composition root yet (deferred to the seam that
// wires the reader + a real provider adapter). CI-B4 adds the normalization
// substrate; the composition root binds the open ports — INTERACTION_REFERENCE_
// PORT (B3) and TRANSCRIPT_ARTIFACT_STORE (over ObjectStorageService) — and
// registers concrete source parsers into TranscriptSourceParserRegistry.
@Module({
  providers: [
    PrismaService,
    ConversationTranscriptRepository,
    ConversationTranscriptService,
    ConversationTranscriptProviderRegistry,
    // CI-B4 — canonical normalization substrate.
    TranscriptNormalizationService,
    TranscriptSourceParserRegistry,
  ],
  exports: [
    ConversationTranscriptService,
    ConversationTranscriptRepository,
    ConversationTranscriptProviderRegistry,
    TranscriptNormalizationService,
    TranscriptSourceParserRegistry,
  ],
})
export class ConversationTranscriptModule {}
