import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { NativeAramoSignatureProvider } from './native-aramo-signature.provider.js';

// SIGN-FREE-PARITY-1 S4 (FP-R5) — the automatic reminder sweep. The same plain interval
// pattern as EsignExpiryWorker (no scheduler, Redis or BullMQ): an interval started on
// bootstrap and cleared on shutdown, with an overlap latch. Each tick takes the open
// envelopes whose planned automatic reminder is due and sends each one through the provider
// (the engine's compare-and-set on the planned time, the send-time verdict and the reminder
// limits decide; the new links go out like a sender reminder's). Running more than one
// process is safe: the compare-and-set lets exactly one send a given reminder.
//
// OFF BY DEFAULT: it runs only when SIGN_AUTO_REMINDER_WORKER_ENABLED=1.
// SIGN_AUTO_REMINDER_INTERVAL_MS sets the tick (default 300000 = 5 minutes, minimum 60000).
// Enabling it in production needs separate PO authorization.

export const AUTO_REMINDER_DEFAULT_INTERVAL_MS = 300_000;
export const AUTO_REMINDER_MIN_INTERVAL_MS = 60_000;
/** Envelopes handled per tick, at most. */
export const AUTO_REMINDER_BATCH = 50;

export function autoReminderWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['SIGN_AUTO_REMINDER_WORKER_ENABLED'] === '1';
}

export function autoReminderIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['SIGN_AUTO_REMINDER_INTERVAL_MS'] ?? AUTO_REMINDER_DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= AUTO_REMINDER_MIN_INTERVAL_MS ? raw : AUTO_REMINDER_DEFAULT_INTERVAL_MS;
}

/** What one tick did. */
export interface AutoReminderTickResult {
  sent: number;
  rescheduled: number;
  stopped: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class EsignAutoReminderWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('EsignAutoReminderWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  // The provider owns both the engine call and the reminder dispatch (same as a sender reminder).
  constructor(private readonly provider: NativeAramoSignatureProvider) {}

  /** True once the interval is scheduled (only when enabled). */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!autoReminderWorkerEnabled(process.env)) return;
    this.timer = setInterval(() => void this.tick(), autoReminderIntervalMs(process.env));
    this.timer.unref?.();
    this.logger.log('automatic reminder worker enabled');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One sweep. Public so tests drive it deterministically.
  async tick(now: Date = new Date()): Promise<AutoReminderTickResult> {
    const result: AutoReminderTickResult = { sent: 0, rescheduled: 0, stopped: 0, skipped: 0, failed: 0 };
    if (this.running || this.stopped) return result;
    this.running = true;
    try {
      const due = await this.provider.dueAutoReminders(now, AUTO_REMINDER_BATCH);
      for (const d of due) {
        if (this.stopped) break;
        try {
          const outcome = await this.provider.sendAutoReminder(d.tenant_id, d.envelope_id, d.planned_at, now);
          result[outcome.kind === 'sent' ? 'sent' : outcome.kind === 'rescheduled' ? 'rescheduled' : outcome.kind === 'stopped' ? 'stopped' : 'skipped'] += 1;
        } catch (err) {
          // Left as planned: the next tick tries again.
          result.failed += 1;
          this.logger.warn(`automatic reminder failed for envelope ${d.envelope_id}: ${(err as Error).message}`);
        }
      }
      if (result.sent > 0) this.logger.log(`sent ${result.sent} automatic reminder(s)`);
      return result;
    } catch (err) {
      this.logger.warn(`automatic reminder tick failed: ${(err as Error).message}`);
      return result;
    } finally {
      this.running = false;
    }
  }
}
