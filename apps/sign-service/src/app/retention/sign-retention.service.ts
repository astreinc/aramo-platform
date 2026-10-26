import { Injectable, Logger } from '@nestjs/common';
import { SignRetentionRepository, type SweepCounts } from '@aramo/sign';

// Privacy Notice 1.1 remediation — one retention run (E-1 to E-4).
// Governing: Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED §4, decisions 2 to 5.
// The repository holds the deletion rules, holds and audit; this service runs each job
// in bounded batches and logs counts only (never a user, row or token identifier).

export const RETENTION_BATCH_SIZE = 500;
// At most this many batches per sweep job per run, so one run stays bounded; anything
// left over is taken by the next run.
export const RETENTION_MAX_BATCHES = 20;
export const CONVENIENCE_TARGETS_PER_RUN = 200;

export interface RetentionRunOptions {
  /** E-4 runs only when enabled (SIGN_RETENTION_QUEUE_CLEANUP_ENABLED=1). */
  queues: boolean;
}

export interface RetentionRunReport {
  convenience: { purged: number; held: number; skipped: number; failed: number };
  native_sessions: number;
  revoked_push_devices: number;
  idempotency_keys: number;
  notification_outbox: number | null;
  push_jobs: number | null;
}

@Injectable()
export class SignRetentionService {
  private readonly log = new Logger('SignRetention');

  constructor(private readonly repo: SignRetentionRepository) {}

  async run(options: RetentionRunOptions, now: Date = new Date()): Promise<RetentionRunReport> {
    const convenience = await this.purgeConvenienceData(now);
    const report: RetentionRunReport = {
      convenience,
      native_sessions: await this.drain((n) => this.repo.sweepNativeSessions(now, n)),
      revoked_push_devices: await this.drain((n) => this.repo.sweepRevokedPushDevices(now, n)),
      idempotency_keys: await this.drain((n) => this.repo.sweepIdempotencyKeys(now, n)),
      notification_outbox: options.queues ? await this.drain((n) => this.repo.sweepNotificationOutbox(now, n)) : null,
      push_jobs: options.queues ? await this.drain((n) => this.repo.sweepFinishedPushJobs(now, n)) : null,
    };
    this.log.log(
      `retention run: convenience purged=${convenience.purged} held=${convenience.held} skipped=${convenience.skipped} failed=${convenience.failed}` +
        ` native_sessions=${report.native_sessions} revoked_push_devices=${report.revoked_push_devices} idempotency_keys=${report.idempotency_keys}` +
        ` notification_outbox=${report.notification_outbox ?? 'off'} push_jobs=${report.push_jobs ?? 'off'}`,
    );
    return report;
  }

  // E-1 — each due (tenant, user) in its own transaction, so one failure never blocks the rest.
  private async purgeConvenienceData(now: Date): Promise<RetentionRunReport['convenience']> {
    const tally = { purged: 0, held: 0, skipped: 0, failed: 0 };
    const targets = await this.repo.dueConvenienceTargets(now, CONVENIENCE_TARGETS_PER_RUN);
    for (const target of targets) {
      try {
        const outcome = await this.repo.purgeConvenienceData(target, now);
        tally[outcome.status] += 1;
      } catch (err) {
        tally.failed += 1;
        this.log.warn(`convenience-data purge failed (${target.reason}): ${(err as Error).name}`);
      }
    }
    return tally;
  }

  private async drain(batch: (limit: number) => Promise<SweepCounts>): Promise<number> {
    let total = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
      const counts = await batch(RETENTION_BATCH_SIZE);
      const deleted = counts.reduce((sum, c) => sum + c.deleted, 0);
      total += deleted;
      if (deleted < RETENTION_BATCH_SIZE) break;
    }
    return total;
  }
}
