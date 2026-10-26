import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommercialAlertService } from '@aramo/subscription';

import {
  CCP_ALERTS_DEFAULT_INTERVAL_MS,
  CommercialAlertScannerWorker,
  commercialAlertsEnabled,
  commercialAlertsIntervalMs,
} from '../app/platform/commercial-alert-scanner.service.js';

// CCP-D3 — the alert scanner is OFF by default (CCP_ALERTS_ENABLED=1 only), arms no timer when
// off, reads the thresholds from env on each tick and never throws.

describe('CCP-D3 alert scanner worker', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.useRealTimers();
  });

  it('D3-W-1 off unless exactly 1; interval default 5 min, floor 10 s', () => {
    expect(commercialAlertsEnabled({})).toBe(false);
    for (const v of ['0', 'true', 'yes', '', ' 1']) expect(commercialAlertsEnabled({ CCP_ALERTS_ENABLED: v })).toBe(false);
    expect(commercialAlertsEnabled({ CCP_ALERTS_ENABLED: '1' })).toBe(true);
    expect(commercialAlertsIntervalMs({})).toBe(CCP_ALERTS_DEFAULT_INTERVAL_MS);
    expect(CCP_ALERTS_DEFAULT_INTERVAL_MS).toBe(300_000);
    expect(commercialAlertsIntervalMs({ CCP_ALERTS_INTERVAL_MS: '9999' })).toBe(300_000);
    expect(commercialAlertsIntervalMs({ CCP_ALERTS_INTERVAL_MS: 'x' })).toBe(300_000);
    expect(commercialAlertsIntervalMs({ CCP_ALERTS_INTERVAL_MS: '60000' })).toBe(60_000);
  });

  it('D3-W-2 with the flag unset no timer is armed and nothing scans', async () => {
    delete process.env['CCP_ALERTS_ENABLED'];
    const scan = vi.fn();
    const w = new CommercialAlertScannerWorker({ scan } as unknown as CommercialAlertService);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    await w.onApplicationShutdown();
  });

  it('D3-W-3 with CCP_ALERTS_ENABLED=1 the interval fires a scan with the env thresholds; shutdown clears it', async () => {
    vi.useFakeTimers();
    process.env['CCP_ALERTS_ENABLED'] = '1';
    process.env['CCP_ALERTS_INTERVAL_MS'] = '10000';
    process.env['CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES'] = '90';
    const scan = vi.fn(async () => ({ skipped: undefined }));
    const w = new CommercialAlertScannerWorker({ scan } as unknown as CommercialAlertService);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect((scan.mock.calls[0] as unknown[])[1]).toEqual({ pending_provider_stuck_minutes: 90, approval_expiry_lead_minutes: 720 });
    await w.onApplicationShutdown();
    expect(w.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('D3-W-4 a tick reports SCANNED / LOCKED, and a failing scan never throws (FAILED)', async () => {
    const scan = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ skipped: 'LOCKED' }).mockRejectedValueOnce(new Error('db down'));
    const w = new CommercialAlertScannerWorker({ scan } as unknown as CommercialAlertService);
    expect(await w.tick(new Date('2026-10-26T12:00:00Z'))).toBe('SCANNED');
    expect(await w.tick()).toBe('LOCKED');
    expect(await w.tick()).toBe('FAILED');
    await w.onApplicationShutdown();
    expect(await w.tick()).toBe('SKIPPED');
  });
});
