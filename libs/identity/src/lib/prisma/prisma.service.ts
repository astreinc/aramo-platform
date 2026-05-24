import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the identity module. Wraps the identity
// Prisma client; each module owns its own generated client (ADR-0001 D3 /
// Architecture v2.0 §7 schema-per-module).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// M3 PR-17 / F21 — lazy first-use validation. The constructor performs NO
// env read for validation, NO throw; it stores the @Optional() databaseUrl
// argument and constructs the PrismaPg adapter (possibly with an empty
// connection string — PrismaPg tolerates that at adapter construction).
// DATABASE_URL validation fires lazily at first DB access via the
// `$connect` override below, preserving the same
// `'DATABASE_URL is not configured'` error message byte-identical. Mirrors
// libs/job-domain's post-PR-7 reference pattern — the workspace
// application of the F11/F14 lazy-validation lesson. `OnModuleInit` is
// removed (retaining it would re-introduce the eager-validation hazard at
// Nest's app.init layer); `OnModuleDestroy` is retained for connection
// teardown.
//
// @Optional() on the constructor's databaseUrl parameter so Nest DI does
// not try to resolve a String token (the F11 lesson, guarded by
// apps/api/src/tests/app-module-di.spec.ts). Tests may pass an explicit
// URL (`new PrismaService(url)`); production wiring relies on the
// process.env['DATABASE_URL'] fallback.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  // M4-close HK-PR-4 — Style B (field-factory) AramoLogger adoption.
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (identity)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'identity' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
