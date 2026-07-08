import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { AppModule } from '../app.module.js';

// TR-4 B2 (DDR §3.4) — the one-time CLAIMS-ledger backfill CLI. Routes existing
// `talent_evidence` EMPLOYMENT/SKILL rows that lack a ledger counterpart into the
// trust ledger as canonical CLAIMS evidence, via the SAME idempotent per-talent
// path the live examine reconcile uses (the §3.2 source_ref existence check). So
// it is safe to re-run: a second pass reports zero writes. Recompute rides each
// subject's writes as always.
//
// The producer owns its ledger write (DDR §1) — this CLI is an operational
// entrypoint above the wall that wires the app context and invokes
// TalentExtractionService; it is NOT a poll and NOT a request-path trigger.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/claims-ledger-backfill.command.js <tenant_id>
//   node dist/apps/api/src/talent-anchor/claims-ledger-backfill.command.js --all-tenants
async function main(): Promise<void> {
  const logger = new Logger('ClaimsLedgerBackfill');
  const arg = process.argv[2];
  if (arg === undefined || arg.trim().length === 0) {
    logger.error('usage: claims-ledger-backfill <tenant_id> | --all-tenants');
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const extraction = ctx.get(TalentExtractionService);
    const tenantIds =
      arg === '--all-tenants' ? await extraction.listTenantIdsWithEvidence() : [arg];
    if (arg === '--all-tenants') {
      logger.log(`claims-ledger backfill --all-tenants: ${tenantIds.length} tenant(s) with evidence`);
    }
    let grandSkills = 0;
    let grandWork = 0;
    let grandSkipped = 0;
    for (const tenantId of tenantIds) {
      const result = await extraction.backfillLedgerForTenant(tenantId);
      grandSkills += result.skills_written;
      grandWork += result.work_history_written;
      grandSkipped += result.skipped;
      logger.log(
        `claims-ledger backfill tenant=${tenantId}: ${result.talents} talent(s), ` +
          `${result.skills_written} skill + ${result.work_history_written} employment evidence written, ` +
          `${result.skipped} already present`,
      );
    }
    logger.log(
      `claims-ledger backfill complete: ${grandSkills} skill + ${grandWork} employment written, ${grandSkipped} skipped ` +
        `across ${tenantIds.length} tenant(s)`,
    );
  } finally {
    await ctx.close();
  }
}

void main();
