import { NestFactory } from '@nestjs/core';
import { createAramoLogger } from '@aramo/common';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';

import { TalentIntakeWorkerModule } from './talent-intake-consumer/talent-intake-worker.module.js';

// ADR-0033 / single-box — GOVERNED operational redrive CLI. Resets a stuck
// draft's UNPUBLISHED outbox events (exhausted attempts / quarantined) so the
// talent-intake-worker re-claims and re-delivers them (QUEUED → PROCESSING →
// terminal). This is the supported, idempotent recovery for a draft stuck at
// QUEUED — NOT manual SQL. Logs by draft/event id only (no résumé PII, no
// secrets). Run on the box, e.g.:
//   docker compose -p aramo-singlebox run --rm talent-intake-worker \
//     node dist/apps/api/src/talent-intake-redrive.main.js <draftId> <tenantId>
async function main(): Promise<void> {
  const logger = createAramoLogger('TalentIntakeRedrive');
  const draftId = (process.argv[2] ?? '').trim();
  const tenantId = (process.argv[3] ?? '').trim();
  if (draftId === '' || tenantId === '') {
    logger.error({
      event: 'talent_intake_redrive_usage',
      message: 'usage: talent-intake-redrive <draftId> <tenantId>',
    });
    process.exit(2);
  }

  // One-shot: never start the drain timer in THIS process (the long-running
  // talent-intake-worker owns delivery).
  process.env['TALENT_INTAKE_DRAIN_ENABLED'] = '0';

  const app = await NestFactory.createApplicationContext(TalentIntakeWorkerModule, {
    bufferLogs: false,
  });
  try {
    const repo = app.get(TalentEvidenceRepository, { strict: false });
    const reset = await repo.redriveTalentIntakeOutboxByDraft({
      tenant_id: tenantId,
      draft_id: draftId,
    });
    logger.log({
      event: 'talent_intake_redrive_done',
      tenant_id: tenantId,
      draft_id: draftId,
      outbox_events_reset: reset,
    });
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error({
      event: 'talent_intake_redrive_failed',
      tenant_id: tenantId,
      draft_id: draftId,
      reason: err instanceof Error ? err.message : 'unknown',
    });
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('talent-intake-redrive failed', err);
  process.exit(1);
});
