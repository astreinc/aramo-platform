import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the skills-taxonomy module. Wraps the
// skills-taxonomy Prisma client; each module owns its own generated client
// (ADR-0001 D3 / Architecture v2.0 §7 schema-per-module). Mirrors
// libs/talent-evidence's post-F21 lazy-validation reference pattern verbatim.
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter. The constructor performs NO env read for
// validation and NO throw; DATABASE_URL validation fires lazily at first DB
// access via the $connect override, preserving the byte-identical
// 'DATABASE_URL is not configured' message. @Optional() on the databaseUrl
// parameter keeps Nest DI from trying to resolve a String token (the F11
// lesson). Tests pass an explicit URL; production relies on the env fallback.
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
    this.logger.log('PrismaService (skills-taxonomy) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
