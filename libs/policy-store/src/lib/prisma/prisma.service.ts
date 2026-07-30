import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the policy-store library. Wraps the
// policy-store Prisma client; policy-store owns its own generated client
// (the libs/job-domain + libs/consent + libs/examination prisma.service.ts
// precedent).
//
// This library ships NO NestJS module, controller or endpoint (PR-2 hard
// prohibition). PrismaService remains @Injectable so a later consumer PR
// (PR-3) can wire it through DI; on its own it is an ordinary class that
// tests and callers may construct directly (`new PrismaService(url)`).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// Lazy first-use validation (the job-domain D-M3-PR7-DI-1 pattern): the
// constructor performs NO env read for validation and NO throw; it stores
// the @Optional() databaseUrl argument and constructs the PrismaPg adapter
// with whatever connection string is currently resolvable. DATABASE_URL
// validation fires lazily at first DB access via the `$connect` override,
// preserving the `'DATABASE_URL is not configured'` message verbatim. No
// OnModuleInit hook — an eager Nest-init-time `$connect` would re-introduce
// the eager-validation hazard that pattern removes.
//
// @Optional() on databaseUrl so Nest DI (when a future module wires this)
// does not try to resolve a String token; tests pass an explicit URL,
// production wiring relies on the process.env['DATABASE_URL'] fallback.
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
    this.logger.log('PrismaService (policy-store) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
