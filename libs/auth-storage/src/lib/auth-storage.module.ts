import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { HostAuthProfileRepository } from './host-auth-profile.repository.js';
import { HostAuthProfileStore } from './host-auth-profile.store.js';
import { NativeDeviceSessionRepository } from './native-device-session.repository.js';
import { NativeDeviceSessionService } from './native-device-session.service.js';
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
    // AUTH-SIGNIN-1 Amendment M-A1 — native device sessions + redeemed-code ledger.
    NativeDeviceSessionRepository,
    NativeDeviceSessionService,
  ],
  exports: [RefreshTokenService, HostAuthProfileStore, NativeDeviceSessionService],
})
export class AuthStorageModule {}
