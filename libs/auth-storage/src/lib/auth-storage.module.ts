import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { RefreshTokenRepository } from './refresh-token.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';

// PR-8.0a-Reground §7. AuthStorageModule exports RefreshTokenService only;
// PrismaService and RefreshTokenRepository are internal implementation
// detail (consistent with libs/identity wiring: services are the public
// surface; repositories are not exported).
@Module({
  imports: [CommonModule],
  providers: [PrismaService, RefreshTokenRepository, RefreshTokenService],
  exports: [RefreshTokenService],
})
export class AuthStorageModule {}
