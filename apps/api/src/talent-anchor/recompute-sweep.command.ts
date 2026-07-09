import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';

// TR-5 B1 (DDR §2) — the manual decay-recompute escape hatch, on the
// match-backfill CLI conventions. Drains the time gate to completion (optionally
// scoped to one tenant), recomputing each stale ACTIVE subject so decay is
// re-priced now. Idempotent — safe to re-run; each recompute advances
// last_recomputed_at past the threshold, so a second pass drains nothing.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/recompute-sweep.command.js <tenant_id>
//   node dist/apps/api/src/talent-anchor/recompute-sweep.command.js --all-tenants
async function main(): Promise<void> {
  const logger = new Logger('RecomputeSweep');
  const arg = process.argv[2];
  if (arg === undefined || arg.trim().length === 0) {
    logger.error('usage: recompute-sweep <tenant_id> | --all-tenants');
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const service = ctx.get(RecomputeSweepService);
    const tenantId = arg === '--all-tenants' ? undefined : arg;
    const result = await service.runToCompletion(tenantId);
    logger.log(
      `recompute-sweep complete${tenantId ? ` tenant=${tenantId}` : ' (all tenants)'}: ` +
        `${result.recomputed} subject(s) recomputed, ${result.failed} failed`,
    );
  } finally {
    await ctx.close();
  }
}

void main();
