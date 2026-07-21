import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// SRC-2 PR-3 — per-module PrismaService for the job_distribution schema. Same
// lazy-validation pattern as the requisition/workspace norm. Extends this lib's
// OWN generated client (relative import — NOT an @aramo edge), so the lib stays
// buildable-import-free. Exported as JobDistributionPrismaService from index.ts to
// avoid colliding with the other modules' PrismaService at apps/api import sites.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (job-distribution)');
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
    this.logger.log('PrismaService (job-distribution) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
