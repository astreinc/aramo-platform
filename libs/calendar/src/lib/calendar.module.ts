import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { CalendarController } from './calendar.controller.js';
import { CalendarRepository } from './calendar.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// CalendarModule — PR-A6 Gate 5+6 (combined) ATS finisher.
//
// Leaf import set (lint:nx-boundaries — no domain back-edges):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//
// Calendar is STANDALONE — does NOT import any other ATS-domain lib.
// owner_id is a logical identity.User UUID with no typed dependency.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [CalendarController],
  providers: [PrismaService, CalendarRepository],
  exports: [CalendarRepository],
})
export class CalendarModule {}
