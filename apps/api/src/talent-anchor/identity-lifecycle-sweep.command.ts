import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { IdentityLifecycleSweepService } from '../talent-identity/identity-lifecycle-sweep.service.js';

// TR-2b B2a (Directive §PR-1.3) — the manual identity-index lifecycle escape
// hatch, on the recompute-sweep CLI conventions. Keyset-loops the whole cluster
// estate: orphan purge (LIVE duty) + dormant detection (DARK, report-only). NO
// HTTP surface.
//
// DRY-RUN IS THE DEFAULT for the purge duty (a would-purge inventory + the
// dormant report, ZERO cluster deletes). The live run requires `--execute`.
// Idempotent — a re-run over a purged estate reports nothing to purge.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/identity-lifecycle-sweep.command.js
//   node dist/apps/api/src/talent-anchor/identity-lifecycle-sweep.command.js --execute
async function main(): Promise<void> {
  const logger = new Logger('IdentityLifecycleSweep');
  const execFlag = process.argv[2];
  const dryRun = execFlag !== '--execute';

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const service = ctx.get(IdentityLifecycleSweepService);
    const result = await service.runToCompletion({ dryRun });
    logger.log(
      `identity-lifecycle-sweep complete (${dryRun ? 'DRY-RUN' : 'EXECUTE'}): ` +
        `scanned=${result.scanned}, ` +
        `orphans_${dryRun ? 'would_purge' : 'purged'}=${result.orphans_purged}, ` +
        `dormant_detected=${result.dormant_detected}, ` +
        `dormant_minted=${result.dormant_minted}, failed=${result.failed}`,
    );
    if (dryRun) {
      logger.log(
        'DRY-RUN — no clusters were purged. Re-run with --execute to purge orphans.',
      );
    }
  } finally {
    await ctx.close();
  }
}

void main();
