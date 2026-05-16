import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRepository } from './talent.repository.js';
import { TalentService } from './talent.service.js';

// libs/talent module: expanded from the PR-1 scaffold in PR-10.
// Provides Talent + TalentTenantOverlay CRUD via TalentService.
// Services are the public surface (mirrors libs/identity export shape);
// TalentRepository and PrismaService remain internal providers.
@Module({
  imports: [CommonModule],
  providers: [PrismaService, TalentRepository, TalentService],
  exports: [TalentService],
})
export class TalentModule {}
