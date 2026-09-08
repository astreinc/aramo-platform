import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { ConversationTranscriptRepository } from './conversation-transcript.repository.js';
import { ConversationTranscriptService } from './conversation-transcript.service.js';
import { ConversationTranscriptProviderRegistry } from './provider/conversation-transcript-provider.registry.js';

// ConversationTranscriptModule — CI-B3 provider-neutral transcript substrate.
//
// Boring, explicit composition: each concrete implementation is bound exactly
// ONCE. The ConversationTranscriptProviderRegistry ships EMPTY (no adapter
// registered in B3; Zoom = CI-B5Z, Teams = CI-B5M). The InteractionReferencePort
// (INTERACTION_REFERENCE_PORT) is intentionally NOT bound here — it is a
// composition-root concern (apps/api reads communications legally). This module
// exposes NO controller/route (internal substrate; no API surface in B3) and is
// NOT imported into the api composition root yet (deferred to the seam that
// wires the reader + a real provider adapter).
@Module({
  providers: [
    PrismaService,
    ConversationTranscriptRepository,
    ConversationTranscriptService,
    ConversationTranscriptProviderRegistry,
  ],
  exports: [
    ConversationTranscriptService,
    ConversationTranscriptRepository,
    ConversationTranscriptProviderRegistry,
  ],
})
export class ConversationTranscriptModule {}
