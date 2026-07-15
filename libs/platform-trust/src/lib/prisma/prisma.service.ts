import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the platform-trust module (TR-2b B2a). Wraps the
// platform-trust Prisma client; each module owns its own generated client
// (ADR-0001 D3 / Architecture v2.x §7 schema-per-module). Mirrors
// libs/identity-index's and libs/portal-identity's PrismaService exactly.
//
// Lazy first-use validation: the constructor performs NO env read for validation
// and NO throw; DATABASE_URL validation fires lazily at first DB access via the
// `$connect` override. @Optional() databaseUrl so Nest DI does not try to
// resolve a String token; tests may pass an explicit URL.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
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
    this.logger.log('PrismaService (platform-trust) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
