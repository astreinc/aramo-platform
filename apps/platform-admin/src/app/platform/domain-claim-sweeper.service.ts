import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { DomainClaimService } from '@aramo/identity';

// Domain-Enforcement P3 (LOCKED) §2 — the opt-in domain-claim expiry sweep. A
// PROVISIONAL claim expires 30 days after creation; the next claim attempt on the
// same domain lapses it anyway (under the per-domain lock), so this sweep only
// keeps the stored state tidy. OFF unless DOMAIN_CLAIM_SWEEP_ENABLED=1; interval
// DOMAIN_CLAIM_SWEEP_INTERVAL_MS (default 1 hour). Same shape as the Sign expiry
// worker: a plain interval with an overlap latch; running more than one process
// is safe (each lapse takes the domain's advisory lock and re-checks expiry).
export const DOMAIN_CLAIM_SWEEP_DEFAULT_INTERVAL_MS = 3_600_000;

export function domainClaimSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['DOMAIN_CLAIM_SWEEP_INTERVAL_MS'] ?? DOMAIN_CLAIM_SWEEP_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DOMAIN_CLAIM_SWEEP_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class DomainClaimSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('DomainClaimSweeper');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly domainClaims: DomainClaimService) {}

  onApplicationBootstrap(): void {
    if (process.env['DOMAIN_CLAIM_SWEEP_ENABLED'] !== '1') return;
    this.timer = setInterval(() => void this.tick(), domainClaimSweepIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sweep (public so tests can drive it). Returns how many claims lapsed. */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const n = await this.domainClaims.sweepExpired(now);
      if (n > 0) this.logger.log(`lapsed ${n} expired provisional domain claim(s)`);
      return n;
    } catch (err) {
      this.logger.warn(`domain-claim sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
