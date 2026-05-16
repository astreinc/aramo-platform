import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the talent module. Wraps the talent
// Prisma client; talent owns its own generated client (per the
// libs/consent + libs/identity prisma.service.ts precedent).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// @Optional() on the constructor's databaseUrl parameter so Nest DI does
// not try to resolve a String token. Tests may pass an explicit URL
// (`new PrismaService(url)`); production wiring relies on the
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
    this.logger.log('PrismaService (talent) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
