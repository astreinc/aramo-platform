import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the talent-evidence module. Wraps the
// talent-evidence Prisma client; talent-evidence owns its own generated
// client (per the libs/consent + libs/examination + libs/identity +
// libs/ingestion + libs/talent + libs/auth-storage + libs/job-domain
// prisma.service.ts precedent).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// @Optional() on the constructor's databaseUrl parameter so Nest DI does
// not try to resolve a String token (the F11 lesson, guarded by
// apps/api/src/tests/app-module-di.spec.ts). Tests may pass an explicit
// URL (`new PrismaService(url)`); production wiring relies on the
// process.env['DATABASE_URL'] fallback.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Optional() databaseUrl?: string) {
    const connectionString = databaseUrl ?? process.env['DATABASE_URL'];
    if (connectionString === undefined || connectionString.length === 0) {
      throw new Error('DATABASE_URL is not configured');
    }
    super({
      adapter: new PrismaPg({ connectionString }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('PrismaService (talent-evidence) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
