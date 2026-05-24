import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the evidence module (M4 PR-1). Ninth
// model-bearing PrismaService in the workspace, joining the eight from
// post-PR-17 closure (libs/auth-storage, libs/consent, libs/examination,
// libs/identity, libs/ingestion, libs/job-domain, libs/talent,
// libs/talent-evidence).
//
// Post-PR-17 uniform lazy pattern per M4 PR-1 directive §4.4 / Ruling 7
// (F21-amended §8.1-B item 7). Same four-step pattern as the seven
// PR-17-remediated services + the reference libs/job-domain:
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
// does not try to resolve a String token (the F11 lesson, guarded by
// apps/api/src/tests/app-module-di.spec.ts). Tests may pass an explicit
// URL (`new PrismaService(url)`); production wiring relies on the
// process.env['DATABASE_URL'] fallback.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  // M4-close HK-PR-4 — Style B (field-factory) AramoLogger adoption.
  // PrismaService is directly instantiated outside DI in testcontainer
  // setup (`new PrismaService(url)`); field-factory preserves the 28
  // existing test instantiation sites unchanged across the 5 affected
  // libs while routing emissions through the structured AramoLogger
  // pipeline. Lifecycle hooks (onModuleDestroy) unaffected.
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (evidence)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'evidence' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
