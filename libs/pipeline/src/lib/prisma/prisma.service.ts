import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the pipeline module (PR-A5a Gate 5).
// Same lazy-validation pattern as the workspace norm (A2 §3 of the
// pattern of record).
//
// This PrismaService also issues the cross-schema $executeRaw INSERT
// into metering."UsageEvent" via the @aramo/metering recordUsage helper
// composed into the pipeline transition's $transaction array. The
// single Postgres database means cross-schema writes share the same
// transaction scope — Ruling 6 same-transaction atomicity.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (pipeline)');
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
    this.logger.log('PrismaService (pipeline) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
