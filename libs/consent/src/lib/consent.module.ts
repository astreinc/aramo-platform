import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';

import { ConsentController } from './consent.controller.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { SourceConsentService } from './source-consent.service.js';

// M4 PR-3 §4.4 / Ruling 7: IdempotencyService is added as a provider AND
// exported so libs/submittal (and any future module using the same
// consent.IdempotencyKey table) can consume it via ConsentModule import.
@Module({
  imports: [AuthModule, CommonModule],
  controllers: [ConsentController],
  providers: [
    ConsentService,
    ConsentRepository,
    IdempotencyService,
    PrismaService,
    SourceConsentService,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
  exports: [ConsentService, IdempotencyService, SourceConsentService],
})
export class ConsentModule {}
