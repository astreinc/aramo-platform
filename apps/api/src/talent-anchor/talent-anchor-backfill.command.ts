import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';

import { TalentAnchorProducerService } from './talent-anchor-producer.service.js';

// TR-2a-1 — anchor BACKFILL CLI. The write-time interceptor only covers NEW
// talent-record writes; this seeds within-tenant identifier anchors for all
// EXISTING TalentRecords in a tenant, so the matcher (TR-2a-2) starts on a
// complete anchor set (partial coverage → false-split). Idempotent — re-run
// safe (recordAnchor no-ops on anchors that already exist).
//
// Usage (after build):
//   node dist/apps/api/main... — run this entry directly:
//   node dist/apps/api/src/talent-anchor/talent-anchor-backfill.command.js <tenant_id>
async function main(): Promise<void> {
  const logger = new Logger('TalentAnchorBackfill');
  const tenantId = process.argv[2];
  if (tenantId === undefined || tenantId.trim().length === 0) {
    logger.error('usage: talent-anchor-backfill <tenant_id>');
    process.exitCode = 1;
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const producer = ctx.get(TalentAnchorProducerService);
    const result = await producer.backfillTenant(tenantId);
    logger.log(
      `backfill complete tenant=${tenantId}: ${result.records} records, ${result.anchorsWritten} anchors written`,
    );
  } finally {
    await ctx.close();
  }
}

void main();
