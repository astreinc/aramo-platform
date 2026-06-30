import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { IdentityIndexRepository } from './identity-index.repository.js';

// libs/identity-index module — Step 4a (Architecture Realignment, ADR-0016).
// Wires the identity-index-owned PrismaService and the resolution-store
// repository. The cross-tenant PII-free index substrate (PERSON_CLUSTER).
//
// SCOPE (4a): substrate only — NO controller, NO HTTP endpoint, NO Pact
// surface, NO wiring into the canonicalization resolver (that is step 4b).
// Downstream (4b) imports @aramo/identity-index and calls
// IdentityIndexRepository with a tenant-side-computed fingerprint.
@Module({
  providers: [PrismaService, IdentityIndexRepository],
  exports: [IdentityIndexRepository],
})
export class IdentityIndexModule {}
