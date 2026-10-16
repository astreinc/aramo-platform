import { NestFactory } from '@nestjs/core';
import { createAramoLogger } from '@aramo/common';
import { TechnicalScreeningService } from '@aramo/technical-screening';

import { TechnicalScreeningApiModule } from './technical-screening/technical-screening-api.module.js';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §7(c)) — GOVERNED operator redrive
// for a CONFIRMED screening session's PENDING publication intents. Each attempt
// rebuilds the Talent Trust call ONLY from the pinned intent; a PUBLISHED or
// CONFLICT intent is skipped (exactly-once in effect; a CONFLICT is never
// overwritten). Logs by tenant/session/intent id and state only — no observation
// text. Precedent: talent-intake-redrive.main.ts. Run on the box, e.g.:
//   docker compose run --rm api \
//     node dist/apps/api/src/screening-publication-redrive.main.js <tenantId> <sessionId>
const REDRIVE_ACTOR = 'screening-publication-redrive';

async function main(): Promise<void> {
  const logger = createAramoLogger('ScreeningPublicationRedrive');
  const tenantId = (process.argv[2] ?? '').trim();
  const sessionId = (process.argv[3] ?? '').trim();
  if (tenantId === '' || sessionId === '') {
    logger.error({
      event: 'screening_publication_redrive_usage',
      message: 'usage: screening-publication-redrive <tenantId> <sessionId>',
    });
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(TechnicalScreeningApiModule, { bufferLogs: false });
  try {
    const screening = app.get(TechnicalScreeningService, { strict: false });
    const results = await screening.publishPending({
      tenant_id: tenantId,
      session_id: sessionId,
      actor_id: REDRIVE_ACTOR,
      requestId: REDRIVE_ACTOR,
    });
    logger.log({
      event: 'screening_publication_redrive_done',
      tenant_id: tenantId,
      session_id: sessionId,
      attempts: results.map((r) => ({ publication_id: r.publication_id, state: r.state, skipped: r.skipped })),
    });
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error({
      event: 'screening_publication_redrive_failed',
      tenant_id: tenantId,
      session_id: sessionId,
      reason: err instanceof Error ? err.message : 'unknown',
    });
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('screening-publication-redrive failed', err);
  process.exit(1);
});
