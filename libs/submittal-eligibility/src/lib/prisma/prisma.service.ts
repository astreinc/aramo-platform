import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the submittal-eligibility module (L8-B1).
// Owns the submittal_policy-schema connection.
//
// Uniform lazy pattern (client-talent-restriction/submittal precedent): inert
// constructor (no env read, no throw), no eager $connect, lazy first-use
// DATABASE_URL validation memoized behind `validated`, OnModuleDestroy
// $disconnect. @Optional() databaseUrl so Nest DI does not resolve a String
// token (tests may pass an explicit URL).
//
// NOTE (Approach A, §6): the ATOMIC client-submittal command runs at the
// apps/api orchestration boundary on ONE interactive tx that spans schemas via
// parameterized raw SQL. This service owns the policy-admin (non-atomic) reads
// and writes only.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger('PrismaService (submittal-eligibility)');
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
    this.logger.log('PrismaService (submittal-eligibility) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
