import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the company module (PR-A2 Gate 5).
//
// Lazy-validation pattern per the workspace norm (mirrors libs/submittal
// and the nine other model-bearing PrismaServices). Four-step contract:
//   1. Inert constructor — no env read, no throw.
//   2. No OnModuleInit (eager-validation hazard avoided).
//   3. $connect override with `validated` flag memoization. Lazy
//      DATABASE_URL validation on first access; byte-identical error
//      'DATABASE_URL is not configured' on absent env.
//   4. OnModuleDestroy → $disconnect.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (company)');
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
    this.logger.log('PrismaService (company) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
