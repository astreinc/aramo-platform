import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the pre-start-requirement module (Track 3 / E2).
// Owns the pre_start_requirement-schema connection.
//
// Uniform lazy pattern (placement/submittal/CTR precedent): inert constructor
// (no env read, no throw), no OnModuleInit eager $connect, lazy first-use
// DATABASE_URL validation memoized behind `validated`, OnModuleDestroy
// $disconnect. @Optional() databaseUrl so Nest DI does not try to resolve a
// String token (tests pass an explicit URL).
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (pre-start-requirement)');
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
    this.logger.log('PrismaService (pre-start-requirement) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
