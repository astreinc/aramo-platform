import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// Per-module PrismaService for the job-domain module. Wraps the job-domain
// Prisma client; job-domain owns its own generated client (per the
// libs/consent + libs/examination + libs/identity + libs/ingestion +
// libs/talent + libs/auth-storage prisma.service.ts precedent).
//
// Prisma 7 requires the driver-adapter pattern; @prisma/adapter-pg is the
// program-wide Postgres adapter.
//
// D-M3-PR7-DI-1 / PR-7 Directive Scope Amendment v1 — lazy first-use
// validation. The constructor performs NO env read for validation, NO
// throw; it only stores the @Optional() databaseUrl argument and
// constructs the PrismaPg adapter with whatever connection string is
// currently resolvable (possibly empty — PrismaPg tolerates an empty
// connectionString at adapter construction). DATABASE_URL validation
// fires lazily at first DB access via the `$connect` override below,
// preserving the same `'DATABASE_URL is not configured'` error message
// verbatim. This mirrors libs/matching's post-PR-3 RedisConnectionConfig
// lazy pattern (the F14 fix): the constructor is inert and the
// validating/side-effecting step is deferred to first use. Consistent
// with that pattern, no OnModuleInit hook is implemented —
// RedisConnectionConfig has none, and an eager Nest-init-time `$connect`
// would re-introduce the eager-validation hazard this fix removes (which
// is precisely how the latent defect surfaced under PR-7's required
// `imports: [JobDomainModule]` wiring on the libs/matching match-queue
// integration spec). Prisma's driver-adapter client connects on demand at
// first query through `this.$connect`, so the override is dispatched on
// the typical query path; explicit callers (tests, bootstrap utilities)
// trigger the same validation by invoking `$connect()` directly.
//
// Scope: this fix is bounded to `libs/job-domain` per the Scope Amendment
// §3. The workspace-wide application of this lesson to the remaining
// PrismaService instances (libs/auth-storage, libs/consent,
// libs/examination, libs/identity, libs/ingestion, libs/talent,
// libs/talent-evidence) is F21, a separate follow-up.
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
    this.logger.log('PrismaService (job-domain) connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
