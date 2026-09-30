import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the talent-embedding module (Enterprise Search GS-2A).
// Owns the talent_embedding generated client (ADR-0001 D3 schema-per-module). Prisma 7
// driver-adapter pattern (@prisma/adapter-pg). Lazy first-use DATABASE_URL validation via the
// $connect override (F11/F14 lesson; byte-identical 'DATABASE_URL is not configured' message);
// @Optional() databaseUrl so Nest DI never resolves a String token. Exported ALIASED
// (TalentEmbeddingPrismaService) from the barrel to avoid a bare-class-token DI collision.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly explicitUrl?: string;
  private validated = false;

  constructor(@Optional() databaseUrl?: string) {
    super({
      adapter: new PrismaPg({
        connectionString: databaseUrl ?? process.env['DATABASE_URL'] ?? '',
      }),
    });
    this.explicitUrl = databaseUrl;
  }

  override async $connect(): Promise<void> {
    if (!this.validated) {
      const url = this.explicitUrl ?? process.env['DATABASE_URL'];
      if (url === undefined || url.length === 0) {
        throw new Error('DATABASE_URL is not configured');
      }
      this.validated = true;
    }
    await super.$connect();
    this.logger.log('PrismaService (talent-embedding) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
