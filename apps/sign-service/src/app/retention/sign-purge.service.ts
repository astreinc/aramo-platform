import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SignPurgeRepository, type PurgeLevel, type QueueOutcome } from '@aramo/sign';

import { SignArtifactStore } from '../custody/sign-artifact-store.js';

// Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (ebd41d99) W4 — the
// purge engine. One run:
//   1. queue every terminal envelope past its tenant's retention period (R-4, reason retention);
//   2. queue every terminal envelope all of whose parties deleted it (R-10);
//   3. execute every due queued purge: S3 versions first (source, executed, certificate;
//      evidence is kept, LD-3), then the database transaction (SignPurgeRepository.execute).
//      An object still under an S3 Object Lock (R-16) is never bypassed: the envelope waits
//      until the lock's retain-until and is retried then.
// R-13: purging an integration envelope whose executed event was never delivered raises an
// operator alert (the purge is not blocked).
//
// DARK BY DEFAULT: nothing here runs, and every retention write is refused, unless
// SIGN_PURGE_ENABLED=1 (PO authorization 2026-10-31: build dark, enabling is a separate PO
// go-ahead). SIGN_PURGE_INTERVAL_MS sets the run interval (default 1 hour, minimum 60000);
// selection is due-date based, so an hourly run purges each envelope once, when due.

export const PURGE_DEFAULT_INTERVAL_MS = 3_600_000;
export const PURGE_MIN_INTERVAL_MS = 60_000;
export const PURGE_BATCH = 50;

export function purgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PURGE_ENABLED'] === '1';
}

export function purgeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SIGN_PURGE_INTERVAL_MS'] ?? PURGE_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= PURGE_MIN_INTERVAL_MS ? raw : PURGE_DEFAULT_INTERVAL_MS;
}

export interface PurgeRunReport {
  queued_retention: number;
  queued_all_parties: number;
  executed: number;
  waiting_lock: number;
  held: number;
  failed: number;
}

@Injectable()
export class SignPurgeService {
  private readonly log = new Logger('SignPurge');

  constructor(
    private readonly purge: SignPurgeRepository,
    private readonly store: SignArtifactStore,
  ) {}

  get enabled(): boolean {
    return purgeEnabled(process.env);
  }

  async run(now: Date = new Date()): Promise<PurgeRunReport> {
    const report: PurgeRunReport = { queued_retention: 0, queued_all_parties: 0, executed: 0, waiting_lock: 0, held: 0, failed: 0 };
    if (!this.enabled) return report;

    for (const c of await this.purge.retentionDue(now, PURGE_BATCH)) {
      if ((await this.safeQueue(c.tenant_id, c.envelope_id, c.level, 'retention', null, now)) === 'queued') report.queued_retention += 1;
    }
    for (const c of await this.purge.allPartiesDeletedDue(PURGE_BATCH)) {
      if ((await this.safeQueue(c.tenant_id, c.envelope_id, 'DOCUMENTS', 'all_parties_deleted', null, now)) === 'queued') report.queued_all_parties += 1;
    }
    for (const due of await this.purge.dueForExecution(now, PURGE_BATCH)) {
      try {
        await this.alertIfAtsCopyUnconfirmed(due.tenant_id, due.envelope_id);
        const objects = this.store.enabled
          ? await this.store.purgeEnvelopeObjects(due.tenant_id, due.envelope_id, { kinds: ['source', 'executed', 'certificate'], now })
          : { deleted: [], locked: [] };
        if (objects.locked.length > 0) {
          const until = new Date(Math.max(...objects.locked.map((l) => l.retain_until.getTime())) + 1000);
          await this.purge.markWaiting(due.tenant_id, due.envelope_id, until);
          report.waiting_lock += 1;
          this.log.log(`sign_purge.waiting_object_lock envelope_id=${due.envelope_id} locked_versions=${objects.locked.length} until=${until.toISOString()}`);
          continue;
        }
        const out = await this.purge.execute(due.tenant_id, due.envelope_id, { deleted: objects.deleted.length, locked: [] }, now);
        if (out.status === 'executed') report.executed += 1;
        else if (out.status === 'held') report.held += 1;
      } catch (err) {
        report.failed += 1;
        this.log.warn(`sign_purge.execute_failed envelope_id=${due.envelope_id} error=${errText(err)}`);
      }
    }
    const line = `sign_purge.run queued_retention=${report.queued_retention} queued_all_parties=${report.queued_all_parties} executed=${report.executed} waiting_lock=${report.waiting_lock} held=${report.held} failed=${report.failed}`;
    if (report.failed > 0) this.log.warn(line);
    else if (Object.values(report).some((v) => v > 0)) this.log.log(line);
    return report;
  }

  /** R-9 — queue every terminal envelope of the tenant sent from, or signed by, `email`. */
  async queueTargeted(tenant_id: string, email: string, level: PurgeLevel, actor_user_id: string): Promise<number> {
    let queued = 0;
    for (const id of await this.purge.targetedEnvelopeIds(tenant_id, email)) {
      const out = await this.purge.queue(tenant_id, id, { level, reason: 'targeted', actor_user_id });
      if (out === 'queued' || out === 'upgraded') queued += 1;
    }
    return queued;
  }

  /** R-11 — on account closure, queue every terminal envelope with personal-data redaction. */
  async queueForAccountClosure(tenant_id: string, actor_user_id: string): Promise<number> {
    if (!this.enabled) return 0;
    let queued = 0;
    for (const id of await this.purge.tenantTerminalEnvelopeIds(tenant_id)) {
      const out = await this.purge.queue(tenant_id, id, { level: 'DOCUMENTS_AND_METADATA_AND_REDACT', reason: 'account_closed', actor_user_id });
      if (out === 'queued' || out === 'upgraded') queued += 1;
    }
    return queued;
  }

  private async safeQueue(tenant_id: string, envelope_id: string, level: PurgeLevel, reason: 'retention' | 'all_parties_deleted', actor: string | null, now: Date): Promise<QueueOutcome | 'failed'> {
    try {
      return await this.purge.queue(tenant_id, envelope_id, { level, reason, actor_user_id: actor, now });
    } catch (err) {
      this.log.warn(`sign_purge.queue_failed envelope_id=${envelope_id} error=${errText(err)}`);
      return 'failed';
    }
  }

  // R-13 — an integration envelope (sent by an application, e.g. the ATS) whose executed
  // event never reached a 2xx delivery may not have been pulled by the integration yet.
  private async alertIfAtsCopyUnconfirmed(tenant_id: string, envelope_id: string): Promise<void> {
    if ((await this.purge.integrationCopyDelivered(tenant_id, envelope_id)) === false) {
      this.log.warn(`sign_purge.alert_integration_copy_unconfirmed envelope_id=${envelope_id}`);
    }
  }

}

@Injectable()
export class SignPurgeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SignPurgeWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private readonly purge: SignPurgeService) {}

  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!purgeEnabled(process.env)) return;
    this.timer = setInterval(() => void this.tick(), purgeIntervalMs(process.env));
    this.timer.unref?.();
    this.logger.log('purge worker enabled');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One run. Public so tests drive it deterministically.
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.purge.run();
    } catch (err) {
      this.logger.warn(`purge run failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}
