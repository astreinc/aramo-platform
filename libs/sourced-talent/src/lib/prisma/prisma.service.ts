import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the sourced-talent module (Fix-Slice-1). Wraps
// the sourced-talent Prisma client; each module owns its own generated client
// (ADR-0001 D3 / Architecture v2.x §7 schema-per-module).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// Lazy first-use validation (the F11/F14 lesson, applied workspace-wide):
// the constructor performs NO env read for validation and NO throw; it stores
// the @Optional() databaseUrl argument and constructs the PrismaPg adapter
// (possibly with an empty connection string — PrismaPg tolerates that at
// construction). DATABASE_URL validation fires lazily at first DB access via
// the `$connect` override. Mirrors libs/identity-index / libs/talent-trust.
//
// @Optional() on databaseUrl so Nest DI does not try to resolve a String
// token. Tests may pass an explicit URL; production wiring relies on
// process.env['DATABASE_URL'].
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
    this.logger.log('PrismaService (sourced-talent) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
