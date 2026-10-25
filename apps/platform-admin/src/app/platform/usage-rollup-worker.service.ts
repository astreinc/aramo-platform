import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { UsageRollupService } from '@aramo/subscription';

// CCP-D1 (PBD §5.4 row D1) — the usage roll-up worker. OFF unless CCP_USAGE_ROLLUP_ENABLED=1
// (unset or any other value ⇒ off: the PBD D1 recovery is "disable the worker; roll-ups are
// derived"). Interval CCP_USAGE_ROLLUP_INTERVAL_MS (default 1 hour, minimum 1 s). Each tick is
// one UsageRollupService.run(): one REPEATABLE READ transaction over the derived tables only,
// never a write to the AllowanceUsage ledger. Safe with more than one process (a concurrent
// run is BUSY or CONFLICT and writes nothing). Same shape as the personal-lapse sweeper.
export const USAGE_ROLLUP_DEFAULT_INTERVAL_MS = 3_600_000;

export function usageRollupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CCP_USAGE_ROLLUP_ENABLED'] === '1';
}

export function usageRollupIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CCP_USAGE_ROLLUP_INTERVAL_MS'] ?? USAGE_ROLLUP_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : USAGE_ROLLUP_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class UsageRollupWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('UsageRollupWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly usage: UsageRollupService) {}

  /** True once the interval is armed (only with CCP_USAGE_ROLLUP_ENABLED=1). */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!usageRollupEnabled()) return;
    this.timer = setInterval(() => void this.tick(), usageRollupIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One run (public so tests can drive it). Never throws. */
  async tick(): Promise<string> {
    if (this.running || this.stopped) return 'SKIPPED';
    this.running = true;
    try {
      const r = await this.usage.run();
      this.logger.log(JSON.stringify({ event: 'ccp_usage_rollup', status: r.status, metrics: r.metrics }));
      return r.status;
    } catch (err) {
      this.logger.warn(`usage roll-up failed: ${(err as Error).message}`);
      return 'FAILED';
    } finally {
      this.running = false;
    }
  }
}
