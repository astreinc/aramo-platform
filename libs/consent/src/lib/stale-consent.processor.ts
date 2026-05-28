import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { StaleConsentRepository } from './stale-consent.repository.js';
import { STALE_CONSENT_QUEUE_NAME } from './stale-consent.queue.constants.js';

// M5 PR-11 §4.2 — stale-consent BullMQ processor.
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding. Scans
// TalentConsentEvent for contacting-scope grants older than 12 months
// (Decision F substrate at libs/consent/src/lib/consent.repository.ts:134-136
// per PR-4) and inserts a paired action='expired' event for each via
// ConsentRepository.markExpired (PR-11 §4.2 transaction-bounded writer).
//
// Lifecycle: mirrors libs/matching/src/lib/matching.processor.ts pattern
// exactly (ADR-0018 Decision 1):
//   - extraOptions.manualRegistration: true on the BullModule.forRootAsync
//     so the underlying Worker is NOT constructed at module init.
//   - onApplicationBootstrap inspects RedisConnectionConfig.isConfigured;
//     when false, the processor stays unregistered and the daily scan
//     never fires (boot is silent; the directive's "Only an actual queue
//     push/pop may surface a missing/unreachable Redis" gate holds).
//   - When configured, BullRegistrar.register() builds the Worker and
//     starts the BLPOP loop.
//
// The 12-month staleness window constant is hard-coded here (matching the
// consent.repository.ts:136 value); a future change should keep the two
// sites in sync or extract a shared module-level constant.
const STALE_CONSENT_WINDOW_MONTHS = 12;

// Job input shape. Currently empty (the cron-triggered daily scan needs no
// per-invocation parameters); kept as a named type so a future per-tenant
// or per-window override can extend without churning callsites.
export interface StaleConsentScanInput {
  // Reserved for future per-tenant or per-window overrides. Empty at PR-11.
  override_window_months?: number;
}

@Processor(STALE_CONSENT_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class StaleConsentProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly staleRepo: StaleConsentRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('StaleConsentProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<StaleConsentScanInput>): Promise<void> {
    const windowMonths =
      job.data.override_window_months ?? STALE_CONSENT_WINDOW_MONTHS;
    const computedAt = new Date();
    const cutoff = new Date(computedAt);
    cutoff.setMonth(cutoff.getMonth() - windowMonths);

    this.logger.log({
      event: 'stale_consent_scan_starting',
      job_id: job.id ?? null,
      window_months: windowMonths,
      cutoff: cutoff.toISOString(),
    });

    const stale = await this.staleRepo.findStaleContactingGrants({
      cutoff,
      computedAt,
    });

    for (const grant of stale) {
      await this.staleRepo.markExpired({
        tenant_id: grant.tenant_id,
        talent_id: grant.talent_id,
        scope: 'contacting',
        occurred_at: computedAt,
        reason: 'stale_consent_12mo_window',
      });
    }

    this.logger.log({
      event: 'stale_consent_scan_completed',
      job_id: job.id ?? null,
      stale_count: stale.length,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'stale_consent_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
