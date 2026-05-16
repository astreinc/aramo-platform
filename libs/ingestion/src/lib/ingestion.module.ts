import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';

import { IngestionController } from './ingestion.controller.js';
import { IngestionRepository } from './ingestion.repository.js';
import { IngestionService } from './ingestion.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/ingestion module: expanded from the PR-1 scaffold in PR-12.
// Provides the generic POST /v1/ingestion/payloads endpoint
// (passive intake; no crawler / no external search / no autonomous
// discovery per Charter R2). Mirrors the libs/consent module shape:
// controller registered; service exported (the public surface);
// repository + PrismaService internal.
@Module({
  imports: [CommonModule, AuthModule],
  controllers: [IngestionController],
  providers: [PrismaService, IngestionRepository, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
