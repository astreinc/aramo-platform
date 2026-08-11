import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the engagement module (M5 PR-1). Eleventh
// model-bearing PrismaService in the workspace, joining the ten from
// post-PR-17 closure + M4 PR-1 (libs/auth-storage, libs/consent,
// libs/evidence, libs/examination, libs/identity, libs/ingestion,
// libs/job-domain, libs/submittal, libs/talent, libs/talent-evidence).
//
// Post-PR-17 uniform lazy pattern per M5 PR-1 Directive v1.0 §4.3 (no
// amendment in v1.1). Same four-step pattern as the ten existing lazy
// services:
//   1. Inert constructor — no env read, no throw. Only stores the
//      @Optional() databaseUrl argument and constructs the PrismaPg
//      adapter with whatever connection string is currently resolvable
//      (possibly empty — PrismaPg tolerates an empty connectionString
//      at adapter construction).
//   2. No OnModuleInit hook. Eager Nest-init-time `$connect` would
//      re-introduce the eager-validation hazard PR-17 removed (the
//      D-M3-PR7-DI-1 root cause).
//   3. `$connect` override with `validated` flag memoization. Lazy
//      first-use DATABASE_URL validation; byte-identical error
//      `'DATABASE_URL is not configured'` raised on first DB access
//      if the env is still absent.
//   4. OnModuleDestroy hook calling $disconnect.
//
// @Optional() on the constructor's databaseUrl parameter so Nest DI
// does not try to resolve a String token (the F11 lesson). Tests may
// pass an explicit URL (`new PrismaService(url)`); production wiring
// relies on the process.env['DATABASE_URL'] fallback.
//
// M4-close HK-PR-4 — Style B (field-factory) AramoLogger adoption.
// PrismaService is directly instantiated outside DI in testcontainer
// setup (`new PrismaService(url)`); field-factory preserves the
// existing test instantiation pattern across all 10 sibling libs while
// routing emissions through the structured AramoLogger pipeline.
// Lifecycle hooks (onModuleDestroy) unaffected.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (engagement)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'engagement' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
