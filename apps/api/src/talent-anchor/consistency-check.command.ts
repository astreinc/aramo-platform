import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { ConsistencyService } from '../talent-identity/consistency.service.js';

// TR-4 B3 (§3.1) — the manual consistency-check escape hatch, on the match-backfill
// CLI conventions. Drains the watermark gate to completion (optionally scoped to
// one tenant), running the three deterministic detectors per subject. Idempotent —
// safe to re-run; a second pass over unchanged evidence writes nothing. Recompute
// rides each subject's writes as always.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/consistency-check.command.js <tenant_id>
//   node dist/apps/api/src/talent-anchor/consistency-check.command.js --all-tenants
async function main(): Promise<void> {
  const logger = new Logger('ConsistencyCheck');
  const arg = process.argv[2];
  if (arg === undefined || arg.trim().length === 0) {
    logger.error('usage: consistency-check <tenant_id> | --all-tenants');
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const service = ctx.get(ConsistencyService);
    const tenantId = arg === '--all-tenants' ? undefined : arg;
    const result = await service.runToCompletion(tenantId);
    logger.log(
      `consistency-check complete${tenantId ? ` tenant=${tenantId}` : ' (all tenants)'}: ` +
        `${result.checked} subject(s) checked, ${result.failed} failed, ` +
        `${result.contradictions} contradiction(s) raised, ` +
        `${result.gaps_opened} gap(s) opened, ${result.gaps_healed} gap(s) healed`,
    );
  } finally {
    await ctx.close();
  }
}

void main();
