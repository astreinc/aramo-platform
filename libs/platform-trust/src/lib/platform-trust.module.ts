import { Module } from '@nestjs/common';

import { PlatformTrustRepository } from './platform-trust.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// TR-2b B2a — platform-trust module. Exposes the DormantLink repository to
// consumers (the identity-index lifecycle sweep's flag-gated dormant mint; P4
// notice delivery later). The PrismaService stays internal.
@Module({
  providers: [PrismaService, PlatformTrustRepository],
  exports: [PlatformTrustRepository],
})
export class PlatformTrustModule {}
