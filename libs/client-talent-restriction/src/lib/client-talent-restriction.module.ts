import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { ClientTalentRestrictionController } from './client-talent-restriction.controller.js';
import { ClientTalentRestrictionRepository } from './client-talent-restriction.repository.js';

// libs/client-talent-restriction module — Track 3 / E7 (seam 1 of 6).
//
// Record half of the house pattern only (E7 §5): PrismaService (owns the
// client_talent_restriction-schema connection) + the record repository +
// the scoped controller. NO outbox, NO event-log repository.
//
// Imports AuthModule for the JwtAuthGuard class-level guard on the
// controller. Two per-class AramoLogger providers (submittal precedent).
@Module({
  imports: [AuthModule],
  controllers: [ClientTalentRestrictionController],
  providers: [
    PrismaService,
    ClientTalentRestrictionRepository,
    {
      provide: 'ClientTalentRestrictionControllerLogger',
      useFactory: () => createAramoLogger(ClientTalentRestrictionController.name),
    },
    {
      provide: 'ClientTalentRestrictionRepositoryLogger',
      useFactory: () => createAramoLogger(ClientTalentRestrictionRepository.name),
    },
  ],
  exports: [ClientTalentRestrictionRepository],
})
export class ClientTalentRestrictionModule {}
