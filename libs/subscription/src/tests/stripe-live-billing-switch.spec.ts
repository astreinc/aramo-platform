import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BillingCommandService } from '../lib/billing/billing-command.service.js';
import type { BillingProviderReadPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import { BillingStatusReadService } from '../lib/billing/billing-status-read.service.js';
import { SIGN_STRIPE_LIVE_BILLING_FLAG, liveStripeBillingEnabled, liveStripeBillingHeld } from '../lib/billing/live-billing-switch.js';
import type { UsageMeterReportPort } from '../lib/billing/usage-meter.port.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { UsageProviderReportService } from '../lib/usage/usage-provider-report.service.js';
import { SIGN_USAGE_BILLING_FLAG } from '../lib/usage/metered-units.js';
import { liveStripeBillingEnabled as exported } from '../index.js';

// Stripe API Upgrade directive v1.0 §4, ruling Q2 (PO 2026-11-14) — the ONE explicit live-billing switch
// (SIGN_STRIPE_LIVE_BILLING_ENABLED, exactly '1'). For each of the three former hard holds (billing
// command dispatch, billing status reads, usage reports): switch off/on × live/test key.
//   live key + switch off ⇒ held exactly as before; live key + switch on ⇒ runs; test key ⇒ unchanged.

type Mode = 'test' | 'live';
const MATRIX: Array<{ mode: Mode; flag: string | undefined; held: boolean }> = [
  { mode: 'live', flag: undefined, held: true },
  { mode: 'live', flag: '0', held: true },
  { mode: 'live', flag: 'true', held: true },
  { mode: 'live', flag: '1', held: false },
  { mode: 'test', flag: undefined, held: false },
  { mode: 'test', flag: '1', held: false },
];
const label = (c: { mode: Mode; flag: string | undefined }) => `${c.mode} key, switch ${c.flag === undefined ? 'unset' : `='${c.flag}'`}`;

const env = { ...process.env };
const setFlag = (flag: string | undefined) => {
  if (flag === undefined) delete process.env[SIGN_STRIPE_LIVE_BILLING_FLAG];
  else process.env[SIGN_STRIPE_LIVE_BILLING_FLAG] = flag;
};
beforeEach(() => setFlag(undefined));
afterEach(() => {
  process.env = { ...env };
});

describe('the live-billing switch', () => {
  it('is on only for exactly "1" (unset, "0", "true", " 1" are off); exported from the library', () => {
    expect(SIGN_STRIPE_LIVE_BILLING_FLAG).toBe('SIGN_STRIPE_LIVE_BILLING_ENABLED');
    expect(liveStripeBillingEnabled({})).toBe(false);
    for (const v of ['0', 'true', ' 1', 'yes', '']) expect(liveStripeBillingEnabled({ SIGN_STRIPE_LIVE_BILLING_ENABLED: v }), v).toBe(false);
    expect(liveStripeBillingEnabled({ SIGN_STRIPE_LIVE_BILLING_ENABLED: '1' })).toBe(true);
    expect(exported).toBe(liveStripeBillingEnabled);
  });

  for (const c of MATRIX) {
    it(`liveStripeBillingHeld: ${label(c)} ⇒ ${c.held ? 'held' : 'not held'}`, () => {
      expect(liveStripeBillingHeld(c.mode, c.flag === undefined ? {} : { SIGN_STRIPE_LIVE_BILLING_ENABLED: c.flag })).toBe(c.held);
      setFlag(c.flag);
      expect(liveStripeBillingHeld(c.mode)).toBe(c.held);
    });
  }
});

describe('hold 1 — billing command dispatch (billing-command.service)', () => {
  function service(mode: Mode, adjustmentsMode: Mode | null = mode) {
    let claims = 0;
    const prisma = {
      $queryRaw: async () => {
        claims += 1;
        return [];
      },
    } as unknown as PrismaService;
    const commands = { provider: 'STRIPE', isConfigured: () => true, mode: () => mode };
    const adjustments = adjustmentsMode === null ? undefined : { provider: 'STRIPE', mode: () => adjustmentsMode };
    const svc = new BillingCommandService(prisma, { provider: 'STRIPE' } as never, {} as never, commands as never, adjustments as never);
    return { svc, claims: () => claims };
  }

  for (const c of MATRIX) {
    it(`${label(c)} ⇒ ${c.held ? "skipped 'LIVE_MODE', nothing claimed" : 'dispatches (claims)'}`, async () => {
      setFlag(c.flag);
      const { svc, claims } = service(c.mode);
      const tally = await svc.dispatchDue(new Date('2026-11-14T00:00:00Z'));
      if (c.held) {
        expect(tally).toMatchObject({ skipped: 'LIVE_MODE', claimed: 0 });
        expect(claims()).toBe(0);
      } else {
        expect(tally).toMatchObject({ skipped: null, claimed: 0 });
        expect(claims()).toBe(1);
      }
    });
  }

  it('a live-mode adjustment port alone holds dispatch while the switch is off, and not when it is on', async () => {
    const off = service('test', 'live');
    expect(await off.svc.dispatchDue(new Date())).toMatchObject({ skipped: 'LIVE_MODE' });
    setFlag('1');
    const on = service('test', 'live');
    expect(await on.svc.dispatchDue(new Date())).toMatchObject({ skipped: null });
    expect(on.claims()).toBe(1);
  });
});

describe('hold 2 — billing status reads (billing-status-read.service)', () => {
  const T = '019a0000-0000-7000-8000-00000000a001';
  const NOW = new Date('2026-11-14T00:00:00Z');
  function reader(mode: Mode) {
    const reads: string[] = [];
    const sub: ProviderSubscriptionState = {
      provider: 'STRIPE',
      subscription_ref: 'sub_1',
      account_ref: 'acct_1',
      provider_status: 'active',
      current_period_start: new Date('2026-11-01T00:00:00Z'),
      current_period_end: new Date('2026-12-01T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_1',
      tenant_id: T,
      intent_id: null,
      account_country: 'US',
    };
    const r: BillingProviderReadPort = {
      provider: 'STRIPE',
      isConfigured: () => true,
      mode: () => mode,
      retrieveSubscription: async () => {
        reads.push('subscription');
        return sub;
      },
      listSubscriptionInvoices: async () => {
        reads.push('invoices');
        return [];
      },
      retrievePortalConfiguration: async () => {
        reads.push('portal');
        return null;
      },
    };
    return { r, reads };
  }
  const prisma = {
    tenantSubscription: {
      findFirst: async () => ({ id: 's1', source: 'SELF_SERVICE', status: 'ACTIVE', ended_at: null, billing_account_ref: 'acct_1', billing_subscription_ref: 'sub_1' }),
    },
  } as unknown as PrismaService;

  for (const c of MATRIX) {
    it(`${label(c)} ⇒ ${c.held ? 'LIVE_MODE_HELD, no provider read' : 'the provider is read'}`, async () => {
      setFlag(c.flag);
      const { r, reads } = reader(c.mode);
      const s = await new BillingStatusReadService(prisma, r).tenantBillingStatus(T, 'sign', { now: NOW });
      if (c.held) {
        expect(s).toMatchObject({ availability: 'LIVE_MODE_HELD', mode: 'live', invoices: [] });
        expect(reads).toEqual([]);
      } else {
        expect(s).toMatchObject({ availability: 'AVAILABLE', mode: c.mode });
        expect(reads).toEqual(['subscription', 'invoices']);
      }
      process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_1';
      const p = await new BillingStatusReadService(prisma, r).portalConfigurationStatus({ now: NOW });
      expect(p.availability === 'LIVE_MODE_HELD').toBe(c.held);
    });
  }
});

describe('hold 3 — usage reports (usage-provider-report.service)', () => {
  function service(mode: Mode, flag: string | undefined) {
    let reads = 0;
    const prisma = {
      usageProviderReport: {
        findMany: async () => {
          reads += 1;
          return [];
        },
      },
    } as unknown as PrismaService;
    const port: UsageMeterReportPort = {
      provider: 'STRIPE',
      mode: () => mode,
      meterReportingConfigured: () => true,
      reportMeterEvent: async () => ({ provider_event_ref: 'x' }),
    };
    // The usage service reads its injected env (the switch included).
    const e: NodeJS.ProcessEnv = { [SIGN_USAGE_BILLING_FLAG]: '1', ...(flag === undefined ? {} : { [SIGN_STRIPE_LIVE_BILLING_FLAG]: flag }) };
    return { svc: new UsageProviderReportService(prisma, port, { env: e }), reads: () => reads };
  }

  for (const c of MATRIX) {
    it(`${label(c)} ⇒ ${c.held ? "held 'LIVE_MODE', nothing read" : 'reports run'}`, async () => {
      const { svc, reads } = service(c.mode, c.flag);
      const tick = await svc.dispatchDue(new Date('2026-11-14T00:00:00Z'));
      if (c.held) {
        expect(tick).toMatchObject({ held: 'LIVE_MODE', claimed: 0 });
        expect(reads()).toBe(0);
      } else {
        expect(tick).toMatchObject({ held: null, claimed: 0 });
        expect(reads()).toBe(1);
      }
    });
  }

  it('the switch never releases usage reporting that is itself disabled', async () => {
    const prisma = { usageProviderReport: { findMany: async () => [] } } as unknown as PrismaService;
    const port: UsageMeterReportPort = { provider: 'STRIPE', mode: () => 'live', meterReportingConfigured: () => true, reportMeterEvent: async () => ({ provider_event_ref: 'x' }) };
    const svc = new UsageProviderReportService(prisma, port, { env: { [SIGN_STRIPE_LIVE_BILLING_FLAG]: '1' } });
    expect(await svc.dispatchDue(new Date())).toMatchObject({ held: 'DISABLED' });
  });
});
