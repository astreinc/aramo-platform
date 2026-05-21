import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// PR-2 precedent: per-module PrismaService. Each module owns its own
// Prisma client (the consent module's client owns both `consent` and
// `audit` schemas because the grant transaction must atomically write
// to both — distinct clients cannot share a transaction).
//
// Prisma 7 removed `datasourceUrl` and `datasources` from PrismaClient
// options. The connection URL is now passed via a driver adapter
// (PR-2 precedent surfaced from PR-1 stub gap). We use @prisma/adapter-pg
// because the program is Postgres-only (Architecture v2.0 §7).
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
    this.logger.log('PrismaService connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
