import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';

import { ConsentController } from './consent.controller.js';
import { ConsentRepository } from './consent.repository.js';
import { ConsentService } from './consent.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { SourceConsentService } from './source-consent.service.js';

@Module({
  imports: [AuthModule, CommonModule],
  controllers: [ConsentController],
  providers: [
    ConsentService,
    ConsentRepository,
    PrismaService,
    SourceConsentService,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
  exports: [ConsentService, SourceConsentService],
})
export class ConsentModule {}
