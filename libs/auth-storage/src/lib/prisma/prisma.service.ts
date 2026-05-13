import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the auth-storage module. Wraps the
// auth-storage Prisma client (third per-module client in the workspace, after
// libs/consent and libs/identity). Mirrors libs/identity/src/lib/prisma/
// prisma.service.ts and libs/consent/src/lib/prisma/prisma.service.ts.
//
// Per ADR-0001 D3: each module owns its own generated client; the three
// clients do not share a generation directory and cannot collide.
//
// @Optional() on databaseUrl so Nest DI does not try to resolve a String
// token. Tests pass the URL explicitly; production reads from env.
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
    this.logger.log('PrismaService (auth-storage) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
