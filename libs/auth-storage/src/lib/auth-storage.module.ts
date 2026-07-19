import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { HostAuthProfileRepository } from './host-auth-profile.repository.js';
import { HostAuthProfileStore } from './host-auth-profile.store.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RefreshTokenRepository } from './refresh-token.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';

// PR-8.0a-Reground §7. AuthStorageModule exports RefreshTokenService only;
// PrismaService and RefreshTokenRepository are internal implementation
// detail (consistent with libs/identity wiring: services are the public
// surface; repositories are not exported).
//
// Auth-Decoupling PR-1 — also exports HostAuthProfileStore (the host
// auth-profile registry read surface); HostAuthProfileRepository stays internal,
// same repo/service split.
@Module({
  imports: [CommonModule],
  providers: [
    PrismaService,
    RefreshTokenRepository,
    RefreshTokenService,
    HostAuthProfileRepository,
    HostAuthProfileStore,
  ],
  exports: [RefreshTokenService, HostAuthProfileStore],
})
export class AuthStorageModule {}
