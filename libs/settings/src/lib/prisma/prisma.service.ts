import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the settings module (Settings S1).
//
// Lazy-validation pattern (post-PR-17 uniform shape — mirrors entitlement /
// identity / engagement / consent PrismaServices):
//   1. Inert constructor — no env read, no throw. Stores the @Optional()
//      databaseUrl argument and constructs the PrismaPg adapter with whatever
//      connection string is currently resolvable.
//   2. No OnModuleInit hook (avoids the eager-validation hazard the F11
//      lesson surfaced).
//   3. `$connect` override with `validated` flag memoization.
//   4. OnModuleDestroy hook for connection teardown.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (settings)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'settings' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
