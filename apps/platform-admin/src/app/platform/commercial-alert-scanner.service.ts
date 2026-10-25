import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { CommercialAlertService, commercialAlertThresholds } from '@aramo/subscription';

// CCP-D3 (PBD §5.4 row D3) — the operational alert scanner. OFF unless CCP_ALERTS_ENABLED=1 (unset
// or any other value ⇒ off; recovery = leave it off, the register is derived). Interval
// CCP_ALERTS_INTERVAL_MS (default 5 minutes, minimum 10 s). Thresholds (operational configuration,
// never commercial policy; pre-execution D3-C3): CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES (default
// 1440) and CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES (default 720), read on every tick.
//
// Each tick is one CommercialAlertService.scan(): one transaction under a try-advisory lock (a
// concurrent scan in another process skips), READ-ONLY on every source table, writing only the
// alert register; one JSON log line per raise (ccp_alert_raised) and resolve (ccp_alert_resolved)
// and one per scan (ccp_alert_scan). No external paging service. Same shape as the D1 worker.
export const CCP_ALERTS_DEFAULT_INTERVAL_MS = 300_000;
export const CCP_ALERTS_MIN_INTERVAL_MS = 10_000;

export function commercialAlertsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CCP_ALERTS_ENABLED'] === '1';
}

export function commercialAlertsIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['CCP_ALERTS_INTERVAL_MS'] ?? CCP_ALERTS_DEFAULT_INTERVAL_MS);
  return Number.isFinite(n) && n >= CCP_ALERTS_MIN_INTERVAL_MS ? n : CCP_ALERTS_DEFAULT_INTERVAL_MS;
}

@Injectable()
export class CommercialAlertScannerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CommercialAlertScannerWorker');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly alerts: CommercialAlertService) {}

  /** True once the interval is armed (only with CCP_ALERTS_ENABLED=1). */
  get scheduled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    if (!commercialAlertsEnabled()) return;
    this.timer = setInterval(() => void this.tick(), commercialAlertsIntervalMs());
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One scan (public so tests can drive it). Never throws. */
  async tick(now: Date = new Date()): Promise<'SCANNED' | 'LOCKED' | 'SKIPPED' | 'FAILED'> {
    if (this.running || this.stopped) return 'SKIPPED';
    this.running = true;
    try {
      const r = await this.alerts.scan(now, commercialAlertThresholds());
      return r.skipped === 'LOCKED' ? 'LOCKED' : 'SCANNED';
    } catch (err) {
      this.logger.warn(JSON.stringify({ event: 'ccp_alert_scan', failed: true, error: (err as Error).message }));
      return 'FAILED';
    } finally {
      this.running = false;
    }
  }
}
