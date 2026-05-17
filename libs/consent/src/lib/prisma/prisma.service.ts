import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// PR-2 precedent: per-module PrismaService. Each module owns its own
// Prisma client (the consent module's client owns both `consent` and
// `audit` schemas because the grant transaction must atomically write
// to both — distinct clients cannot share a transaction).
//
// Prisma 7 removed `datasourceUrl` and `datasources` from PrismaClient
// options. The connection URL is now passed via a driver adapter
// (PR-2 precedent surfaced from PR-1 stub gap). We use @prisma/adapter-pg
// because the program is Postgres-only (Architecture v2.0 §7).
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
    this.logger.log('PrismaService connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
