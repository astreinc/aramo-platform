import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';

import { IngestionController } from './ingestion.controller.js';
import { IngestionRepository } from './ingestion.repository.js';
import { IngestionService } from './ingestion.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/ingestion module — generic ingestion endpoint (PR-12) +
// Indeed search-results endpoint (PR-13). Passive intake (Charter
// R2: no crawler / no external search / no autonomous discovery).
//
// PR-13 introduces the libs/ingestion → libs/consent edge:
// SourceConsentService (exported by ConsentModule) registers
// per-scope initial consent state on Indeed ingest per Group 2
// v2.3a. The mapping rule lives in libs/consent (Lead Option-1
// ruling per directive §4.3 — consent owns consent semantics).
@Module({
  imports: [CommonModule, AuthModule, ConsentModule],
  controllers: [IngestionController],
  providers: [PrismaService, IngestionRepository, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
