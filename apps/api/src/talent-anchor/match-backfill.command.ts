import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SubjectMatcherService, TalentTrustRepository } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';

// TR-2a-2 — within-tenant same-human MATCHER backfill CLI. Sweeps every anchored
// subject in a tenant and records SAME-HUMAN ADVISORIES (SubjectMatchAdvisory) for
// pairs sharing a normalized anchor. ADVISE-ONLY — it writes advisories for a human
// reviewer and takes ZERO merge action. Idempotent (the canonical-pair unique key
// dedupes), so it is safe to re-run. Run this AFTER the anchor backfill so the matcher
// starts from a complete anchor set.
//
// The matcher is talent_trust-internal (cip) — SubjectMatcherService reads only the
// trust ledger. This CLI is an operational entrypoint above the wall (it wires the app
// context), NOT a request-path trigger.
//
// TR-6 B1 (DDR §2) — retained as the FULL-RESWEEP escape hatch beside the hourly
// incremental sweep (which only re-matches subjects with a new anchor since their
// watermark). `--all-tenants` sweeps every tenant that owns an anchored subject.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/match-backfill.command.js <tenant_id>
//   node dist/apps/api/src/talent-anchor/match-backfill.command.js --all-tenants
async function main(): Promise<void> {
  const logger = new Logger('SubjectMatchBackfill');
  const arg = process.argv[2];
  if (arg === undefined || arg.trim().length === 0) {
    logger.error('usage: match-backfill <tenant_id> | --all-tenants');
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const matcher = ctx.get(SubjectMatcherService);
    const tenantIds =
      arg === '--all-tenants'
        ? await ctx.get(TalentTrustRepository).listTenantIdsWithAnchors()
        : [arg];
    if (arg === '--all-tenants') {
      logger.log(`match backfill --all-tenants: ${tenantIds.length} tenant(s) to sweep`);
    }
    for (const tenantId of tenantIds) {
      const result = await matcher.backfillMatches(tenantId);
      logger.log(
        `match backfill complete tenant=${tenantId}: ${result.subjects} subjects swept, ${result.advisories} advisories`,
      );
    }
  } finally {
    await ctx.close();
  }
}

void main();
