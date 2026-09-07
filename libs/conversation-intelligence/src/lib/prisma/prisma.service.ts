import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the conversation-intelligence module
// (CI-B2). Follows the workspace-uniform post-PR-17 lazy pattern
// (mirrors libs/evidence, libs/ai-draft, libs/job-domain):
//   1. Inert constructor — no env read, no throw. Stores the
//      @Optional() databaseUrl and constructs the PrismaPg adapter with
//      whatever connection string is currently resolvable (possibly
//      empty — PrismaPg tolerates an empty connectionString at adapter
//      construction).
//   2. No OnModuleInit hook (avoids the eager-validation hazard).
//   3. `$connect` override with `validated` flag memoization — lazy
//      first-use DATABASE_URL validation; byte-identical
//      'DATABASE_URL is not configured' error on first DB access if the
//      env is still absent.
//   4. OnModuleDestroy hook calling $disconnect.
//
// @Optional() on databaseUrl so Nest DI does not try to resolve a String
// token (the F11 lesson). Tests may pass an explicit URL
// (`new PrismaService(url)`); production wiring relies on the
// process.env['DATABASE_URL'] fallback.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger: AramoLogger = createAramoLogger(
    'PrismaService (conversation-intelligence)',
  );
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
    this.logger.log({
      event: 'prisma_service_connected',
      surface: 'conversation-intelligence',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
