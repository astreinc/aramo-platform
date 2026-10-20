import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the esign module (DOC-3). Lazy-validation pattern
// (mirrors documents/communications): inert constructor, no OnModuleInit,
// $connect validates + memoizes, OnModuleDestroy -> $disconnect.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (esign)');
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
    this.logger.log('PrismaService (esign) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
