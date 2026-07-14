import { Module } from '@nestjs/common';

import { PortalIdentityRepository } from './portal-identity.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// Portal P1 — portal-identity module. Exposes the repository (the token +
// portal store) to consumers (auth-service portal login; apps/api portal
// reads in P2). The PrismaService stays internal.
@Module({
  providers: [PrismaService, PortalIdentityRepository],
  exports: [PortalIdentityRepository],
})
export class PortalIdentityModule {}
