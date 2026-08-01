import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TenantPolicyCoverageGuard } from '../policy/tenant-policy-coverage.guard.js';
import type { TenantPolicyCoverageRepository } from '../policy/tenant-policy-coverage.repository.js';

// ADR-0024 PR-4a-2 — the startup coverage guard MUST log loud on a coverage gap
// and NEVER throw out of onApplicationBootstrap. A package-less tenant is a
// config gap; it must not become a total outage (never fail-boot).

function buildGuard(
  findUncoveredTenants: TenantPolicyCoverageRepository['findUncoveredTenants'],
): TenantPolicyCoverageGuard {
  return new TenantPolicyCoverageGuard({
    findUncoveredTenants,
  } as unknown as TenantPolicyCoverageRepository);
}

describe('TenantPolicyCoverageGuard (ADR-0024 PR-4a-2)', () => {
  it('logs LOUD at ERROR for a coverage gap and does NOT throw (API still starts)', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const guard = buildGuard(
      vi.fn().mockResolvedValue([
        { tenant_id: 't-1', tenant_name: 'Orphan Co' },
        { tenant_id: 't-2', tenant_name: 'Second Orphan' },
      ]),
    );

    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = String(errorSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('coverage GAP');
    expect(msg).toContain('t-1');
    expect(msg).toContain('t-2');
    errorSpy.mockRestore();
  });

  it('logs OK (no ERROR) when every active tenant is covered', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const logSpy = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await expect(
      buildGuard(vi.fn().mockResolvedValue([])).onApplicationBootstrap(),
    ).resolves.toBeUndefined();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('a scan failure is swallowed — logged, never thrown (never fail-boot)', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      buildGuard(
        vi.fn().mockRejectedValue(new Error('db unreachable at boot')),
      ).onApplicationBootstrap(),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('scan failed');
    errorSpy.mockRestore();
  });
});
