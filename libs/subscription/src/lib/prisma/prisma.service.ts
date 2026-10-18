import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the subscription module (PR-A1b).
//
// Post-PR-17 uniform lazy pattern (same as selection/consent/identity
// PrismaServices):
//   1. Inert constructor — no env read, no throw. Only stores the
//      @Optional() databaseUrl argument and constructs the PrismaPg
//      adapter with whatever connection string is currently resolvable.
//   2. No OnModuleInit hook (avoid eager-validation hazard).
//   3. `$connect` override with `validated` flag memoization.
//   4. OnModuleDestroy hook calling $disconnect.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (subscription)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'subscription' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
