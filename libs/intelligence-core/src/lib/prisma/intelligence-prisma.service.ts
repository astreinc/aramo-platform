import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

import { resolveIntelligenceDatabaseUrl } from './intelligence-database-url.js';

// The TI PrismaService. Unlike the shared-DB module services it resolves its URL
// EAGERLY at construction: an unset INTELLIGENCE_DATABASE_URL fails the boot
// (fail closed) instead of surfacing later as a confusing query error. The
// connection itself is lazy — a database that is down at boot is reported by
// GET /health (503), not by a crash loop.
@Injectable()
export class IntelligencePrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('IntelligencePrismaService');

  constructor(@Optional() databaseUrl?: string) {
    const url = databaseUrl ?? resolveIntelligenceDatabaseUrl();
    super({ adapter: new PrismaPg({ connectionString: url }) });
  }

  /** Round-trip to the TI database. Resolves true on success, false on any error. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRawUnsafe('SELECT 1');
      return true;
    } catch (err) {
      this.logger.warn(`intelligence database ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
