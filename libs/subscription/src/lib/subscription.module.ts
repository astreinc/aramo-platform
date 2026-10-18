import { Module } from '@nestjs/common';

import { AllowanceService } from './allowance.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// SubscriptionModule — the plan/subscription/allowance authority (Multi-Provider
// directive §B/§C). Kept apart from the signing engine and provider routing.
@Module({
  providers: [PrismaService, AllowanceService],
  exports: [AllowanceService],
})
export class SubscriptionModule {}
