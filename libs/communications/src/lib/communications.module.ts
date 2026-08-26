import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { CommunicationsRepository } from './communications.repository.js';
import { CommunicationsService } from './communications.service.js';
import { VoiceProviderRegistry } from './provider/voice-provider.registry.js';

// CommunicationsModule — COMM-V1 provider-neutral domain substrate (COMM-B1).
//
// Boring, explicit composition: each concrete implementation is bound exactly
// ONCE. The VoiceProviderRegistry ships EMPTY (no adapter registered in B1); a
// later slice registers zoom_phone -> ZoomPhoneAdapter. NO controller (no routes
// until COMM-B2) and this module is NOT imported into the api composition root
// yet (composition-root wiring is out of B1 scope).
@Module({
  providers: [
    PrismaService,
    CommunicationsRepository,
    CommunicationsService,
    VoiceProviderRegistry,
  ],
  exports: [CommunicationsService, CommunicationsRepository, VoiceProviderRegistry],
})
export class CommunicationsModule {}
