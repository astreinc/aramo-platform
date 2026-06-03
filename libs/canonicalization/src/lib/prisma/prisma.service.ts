import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createAramoLogger, type AramoLogger } from '@aramo/common';

import { PrismaClient } from '../../../prisma/generated/client/client.js';

// T2-2a — canonicalization PrismaService. Per-module Prisma client per the
// consent (M5 PR-11) + submittal (M6 PR-2) precedent. The canonicalization
// client is a multi-schema client (Option A, Lead-approved per Directive
// §1 Ruling 1) spanning the OWNED `canonicalization` schema plus the
// FOLLOWED `talent` + `talent_evidence` + `ingestion` schemas — necessary
// because the atomic canonicalize $transaction MUST write across all four
// (a partial canonicalization is a corrupt identity).
//
// Lazy first-use validation (the F11/F21 workspace pattern, mirrored from
// libs/consent and the M3 PR-17 lesson):
//   - Constructor performs NO env read for validation, NO throw. The
//     @Optional() databaseUrl arg is stored; the PrismaPg adapter is
//     constructed eagerly (PrismaPg tolerates an empty connection string
//     at adapter-construction time).
//   - DATABASE_URL validation fires lazily at first DB access via the
//     $connect override below — byte-identical error message
//     ('DATABASE_URL is not configured') with libs/consent + libs/submittal.
//   - OnModuleInit is deliberately NOT implemented (it would re-introduce
//     the eager-validation hazard at Nest's app.init layer).
//
// @Optional() on the constructor's databaseUrl parameter so Nest DI does
// not try to resolve a String token; tests may pass an explicit URL
// (`new PrismaService(url)`); production wiring falls back to
// process.env['DATABASE_URL'].
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger: AramoLogger = createAramoLogger('PrismaService (canonicalization)');
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
    this.logger.log({ event: 'prisma_service_connected', surface: 'canonicalization' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
