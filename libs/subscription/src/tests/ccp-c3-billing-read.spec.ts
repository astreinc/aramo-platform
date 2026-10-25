import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BILLING_PROVIDER_COMMAND_PORT,
  BILLING_PROVIDER_PORT,
  BILLING_PROVIDER_READ_PORT,
  BillingProviderUnavailableError,
  type BillingProviderReadPort,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
  type ProviderSubscriptionState,
} from '../lib/billing/billing-provider.port.js';
import { BillingStatusQueryError, BillingStatusReadService, invoicePaymentState } from '../lib/billing/billing-status-read.service.js';
import { STRIPE_READ_ADAPTER_METHODS, StripeBillingReadAdapter } from '../lib/billing/stripe-billing-read.adapter.js';
import { StripeBillingProvider } from '../lib/billing/stripe-billing.provider.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CCP-C3 (PBD §5.2 row C3, mandatory test "Adapter is read-only") — the READ-ONLY PROOF for the
// read-through adapter and service, plus the payment-state table and the designed disabled states.
// No network and no key: the service runs against a recording fake reader; the adapter's
// GET-only HTTP behaviour against a stand-in is C3-W-4 / C3-W-5 in stripe-wire.spec.ts.
// Test IDs are cited by doc/ccp/slices/CCP-C3-acceptance.md.

const SRC = resolve(__dirname, '../lib/billing');
const read = (f: string) => readFileSync(resolve(SRC, f), 'utf8');
const code = (f: string) =>
  read(f)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

// Every mutating provider operation Aramo has (BillingProviderPort + BillingProviderCommandPort).
const MUTATING = ['upsertBillingAccount', 'createCheckoutSession', 'createPortalSession', 'cancelSubscription', 'expireCheckoutSession'] as const;
const PRIVATE_HELPERS = ['secretKey', 'base', 'read'];

function allMethodNames(o: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = Object.getPrototypeOf(o); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n);
  }
  for (const n of Object.keys(o)) if (typeof (o as Record<string, unknown>)[n] === 'function') names.add(n);
  return [...names].sort();
}

describe('CCP-C3 read-only proof — the adapter', () => {
  it('C3-RO-1 the adapter surface is exactly the read methods (+ private helpers); no mutating provider method exists on it or its prototype chain', () => {
    const a = new StripeBillingReadAdapter();
    expect(allMethodNames(a)).toEqual([...STRIPE_READ_ADAPTER_METHODS, ...PRIVATE_HELPERS].sort());
    for (const m of [...MUTATING, 'verifyWebhook', 'retrieveCheckoutSession']) expect(m in a, m).toBe(false);
    // Not the write-capable adapter, and not derived from it.
    expect(a).not.toBeInstanceOf(StripeBillingProvider);
    // The write-capable adapter does hold them (so the check above is meaningful).
    for (const m of MUTATING) expect(m in new StripeBillingProvider(), m).toBe(true);
  });

  it('C3-RO-2 source: the adapter fixes the method to GET, sends no body or idempotency key, and never imports the write-capable class', () => {
    const src = code('stripe-billing-read.adapter.ts');
    expect(src.match(/method:\s*'([A-Z]+)'/g)).toEqual(["method: 'GET'"]);
    expect(src).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    expect(src).not.toMatch(/\bbody\s*[:,]/);
    expect(src).not.toMatch(/idempotency/i);
    expect(src).not.toMatch(/\bStripeBillingProvider\b/);
    // Exactly one fetch call site (the private `read`).
    expect(src.match(/\bfetch\(/g)?.length).toBe(1);
    // Every path it reads is built by the wire translators or is the subscription read.
    expect(src.match(/this\.read\(/g)?.length).toBe(3);
  });

  it('C3-RO-3 source: the read service depends on the READ port only (never the provider or command port), and writes nothing locally', () => {
    const src = code('billing-status-read.service.ts');
    expect(src).toMatch(/@Inject\(BILLING_PROVIDER_READ_PORT\)/);
    expect(src).not.toMatch(/\bBILLING_PROVIDER_PORT\b|\bBILLING_PROVIDER_COMMAND_PORT\b|StripeBillingProvider\b/);
    // Local reads only: no Prisma write, raw SQL or transaction.
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src.match(/tenantSubscription\.findFirst\(/g)?.length).toBe(2);
  });

  it('C3-RO-4 SubscriptionModule (and .forRoot()) binds the read port to the GET-only adapter, distinct from the provider and command ports', async () => {
    await import('reflect-metadata');
    const { Test } = await import('@nestjs/testing');
    const { SubscriptionModule } = await import('../lib/subscription.module.js');
    for (const mod of [SubscriptionModule, SubscriptionModule.forRoot()]) {
      const ref = await Test.createTestingModule({ imports: [mod] }).compile();
      const reader = ref.get(BILLING_PROVIDER_READ_PORT);
      expect(reader).toBeInstanceOf(StripeBillingReadAdapter);
      expect(reader).not.toBe(ref.get(BILLING_PROVIDER_PORT));
      expect(reader).not.toBe(ref.get(BILLING_PROVIDER_COMMAND_PORT));
      for (const m of MUTATING) expect(m in (reader as object), m).toBe(false);
      const svc = ref.get(BillingStatusReadService) as unknown as { reader: unknown };
      expect(svc).toBeInstanceOf(BillingStatusReadService);
      expect(svc.reader).toBe(reader);
      await ref.close();
    }
  });
});

// ------------------------------------------------------------------------------------------
// The service against a recording fake reader (Aramo shapes) and a stub Prisma read.
// ------------------------------------------------------------------------------------------

const T = 'a0000000-0000-7000-8000-00000000c301';
const OTHER = 'a0000000-0000-7000-8000-00000000c302';
const NOW = new Date('2026-10-26T12:00:00.000Z');

function invoice(o: Partial<ProviderInvoiceState> = {}): ProviderInvoiceState {
  return {
    provider: 'STRIPE',
    invoice_ref: 'in_1',
    number: 'A-1',
    account_ref: 'acct_1',
    subscription_ref: 'sub_1',
    provider_status: 'paid',
    currency: 'usd',
    total_minor: 4900,
    amount_due_minor: 4900,
    amount_paid_minor: 4900,
    amount_remaining_minor: 0,
    created_at: new Date('2026-10-01T00:00:00Z'),
    due_at: null,
    period_start: new Date('2026-09-01T00:00:00Z'),
    period_end: new Date('2026-10-01T00:00:00Z'),
    attempt_count: 1,
    next_attempt_at: null,
    hosted_url: 'https://invoice.test/in_1',
    document_url: null,
    live: false,
    ...o,
  };
}

class RecordingReader implements BillingProviderReadPort {
  readonly provider = 'STRIPE' as const;
  configured = true;
  live = false;
  fail: Error | null = null;
  sub: ProviderSubscriptionState = {
    provider: 'STRIPE',
    subscription_ref: 'sub_1',
    account_ref: 'acct_1',
    provider_status: 'active',
    current_period_start: new Date('2026-10-01T00:00:00Z'),
    current_period_end: new Date('2026-11-01T00:00:00Z'),
    cancel_at_period_end: false,
    price_ref: 'price_business',
    tenant_id: T,
    intent_id: null,
    account_country: 'US',
  };
  invoices: ProviderInvoiceState[] = [invoice()];
  portal: ProviderPortalConfigurationState | null = null;
  isConfigured() {
    return this.configured;
  }
  mode(): 'test' | 'live' {
    return this.live ? 'live' : 'test';
  }
  async retrieveSubscription() {
    if (this.fail !== null) throw this.fail;
    return this.sub;
  }
  async listSubscriptionInvoices(_ref: string, limit: number) {
    return this.invoices.slice(0, limit);
  }
  async retrievePortalConfiguration() {
    if (this.fail !== null) throw this.fail;
    return this.portal;
  }
}

/** Wraps the reader so every property access is recorded (the "reachable surface" oracle). */
function recorded(r: RecordingReader): { proxy: BillingProviderReadPort; touched: Set<string> } {
  const touched = new Set<string>();
  const proxy = new Proxy(r, {
    get(target, prop, recv) {
      if (typeof prop === 'string') touched.add(prop);
      const v: unknown = Reflect.get(target, prop, recv);
      // Bound to the fake itself, so the fake's own field reads are not recorded as the service's.
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { proxy, touched };
}

type Row = { id: string; source: string; status: string; ended_at: Date | null; billing_account_ref: string | null; billing_subscription_ref: string | null };
function stubPrisma(rows: { open: Row | null; latest: Row | null }): { prisma: PrismaService; calls: unknown[] } {
  const calls: unknown[] = [];
  const prisma = {
    tenantSubscription: {
      findFirst: async (args: { where: { ended_at?: null } }) => {
        calls.push(args);
        return 'ended_at' in args.where ? rows.open : rows.latest;
      },
    },
  } as unknown as PrismaService;
  return { prisma, calls };
}
const ROW: Row = { id: 's1', source: 'SELF_SERVICE', status: 'ACTIVE', ended_at: null, billing_account_ref: 'acct_1', billing_subscription_ref: 'sub_1' };

describe('CCP-C3 read service — reachable surface and designed states', () => {
  it('C3-RO-5 across every scenario the service touches only the read methods of its reader', async () => {
    const r = new RecordingReader();
    const { proxy, touched } = recorded(r);
    const svc = new BillingStatusReadService(stubPrisma({ open: ROW, latest: ROW }).prisma, proxy);
    await svc.tenantBillingStatus(T, 'sign', { now: NOW });
    r.sub = { ...r.sub, tenant_id: OTHER };
    await svc.tenantBillingStatus(T, 'sign', { now: NOW });
    r.fail = new BillingProviderUnavailableError('down');
    await svc.tenantBillingStatus(T, 'sign', { now: NOW });
    process.env['STRIPE_PORTAL_CONFIGURATION'] = 'bpc_x';
    await svc.portalConfigurationStatus({ now: NOW });
    r.fail = null;
    await svc.portalConfigurationStatus({ now: NOW });
    r.live = true;
    await svc.tenantBillingStatus(T, 'sign', { now: NOW });
    delete process.env['STRIPE_PORTAL_CONFIGURATION'];
    expect([...touched].filter((p) => p !== 'provider').every((p) => (STRIPE_READ_ADAPTER_METHODS as readonly string[]).includes(p))).toBe(true);
    expect([...touched].sort()).toEqual(['isConfigured', 'listSubscriptionInvoices', 'mode', 'provider', 'retrievePortalConfiguration', 'retrieveSubscription']);
  });

  it('C3-S-1 AVAILABLE: the provider subscription and its invoices, each with a payment state; amounts mirrored, never totalled', async () => {
    const r = new RecordingReader();
    r.invoices = [invoice({ invoice_ref: 'in_2', provider_status: 'open', amount_paid_minor: 0, amount_remaining_minor: 4900, attempt_count: 1 }), invoice()];
    const s = await new BillingStatusReadService(stubPrisma({ open: ROW, latest: ROW }).prisma, r).tenantBillingStatus(T, 'sign', { now: NOW });
    expect(s).toMatchObject({ availability: 'AVAILABLE', provider: 'STRIPE', mode: 'test', product_key: 'sign', detail: null });
    expect(s.subscription).toEqual({ id: 's1', source: 'SELF_SERVICE', status: 'ACTIVE', open: true, account_ref: 'acct_1', subscription_ref: 'sub_1' });
    expect(s.provider_subscription).toEqual({ provider_status: 'active', current_period_start: r.sub.current_period_start, current_period_end: r.sub.current_period_end, cancel_at_period_end: false });
    expect(s.invoices.map((i) => [i.invoice_ref, i.payment_state, i.amount_remaining_minor])).toEqual([
      ['in_2', 'PAYMENT_FAILED', 4900],
      ['in_1', 'PAID', 0],
    ]);
    expect(Object.keys(s)).not.toContain('total');
  });

  it('C3-S-2 designed disabled states: unconfigured, live mode (held), no Stripe-owned row, provider failure; none reads further than needed', async () => {
    const r = new RecordingReader();
    r.configured = false;
    const { prisma, calls } = stubPrisma({ open: null, latest: null });
    const svc = new BillingStatusReadService(prisma, r);
    expect(await svc.tenantBillingStatus(T, 'sign', { now: NOW })).toMatchObject({ availability: 'BILLING_UNAVAILABLE', provider: null, mode: null, subscription: null, invoices: [] });
    r.configured = true;
    r.live = true;
    expect(await svc.tenantBillingStatus(T, 'sign', { now: NOW })).toMatchObject({ availability: 'LIVE_MODE_HELD', mode: 'live', invoices: [] });
    expect(calls).toHaveLength(0);
    r.live = false;
    expect(await svc.tenantBillingStatus(T, 'sign', { now: NOW })).toMatchObject({ availability: 'NO_PROVIDER_SUBSCRIPTION', subscription: null, invoices: [] });
    expect(calls).toHaveLength(2);
    r.fail = new BillingProviderUnavailableError('stripe read /v1/subscriptions/sub_1: HTTP 503');
    const down = await new BillingStatusReadService(stubPrisma({ open: ROW, latest: ROW }).prisma, r).tenantBillingStatus(T, 'sign', { now: NOW });
    expect(down).toMatchObject({ availability: 'PROVIDER_UNAVAILABLE', provider_subscription: null, invoices: [] });
    expect(down.detail).toContain('HTTP 503');
  });

  it('C3-S-3 tenant isolation: a provider subscription of another tenant or account, or an invoice of another account or subscription, is TENANT_MISMATCH with no provider data', async () => {
    const svc = (r: RecordingReader) => new BillingStatusReadService(stubPrisma({ open: ROW, latest: ROW }).prisma, r);
    const cases: Array<(r: RecordingReader) => void> = [
      (r) => (r.sub = { ...r.sub, tenant_id: OTHER }),
      (r) => (r.sub = { ...r.sub, tenant_id: null }),
      (r) => (r.sub = { ...r.sub, account_ref: 'acct_other' }),
      (r) => (r.invoices = [invoice(), invoice({ invoice_ref: 'in_x', account_ref: 'acct_other' })]),
      (r) => (r.invoices = [invoice({ subscription_ref: 'sub_other' })]),
      (r) => (r.invoices = [invoice({ subscription_ref: null })]),
    ];
    for (const mutate of cases) {
      const r = new RecordingReader();
      mutate(r);
      const s = await svc(r).tenantBillingStatus(T, 'sign', { now: NOW });
      expect(s).toMatchObject({ availability: 'TENANT_MISMATCH', provider_subscription: null, invoices: [] });
    }
  });

  it('C3-S-4 the open Stripe-owned row is preferred; an ended one is used only when none is open; refusals for an unknown product or a bad limit', async () => {
    const ended = { ...ROW, id: 's0', ended_at: new Date('2026-09-01T00:00:00Z'), status: 'CANCELED' };
    const a = stubPrisma({ open: null, latest: ended });
    const s = await new BillingStatusReadService(a.prisma, new RecordingReader()).tenantBillingStatus(T, 'sign', { now: NOW });
    expect(s.subscription).toMatchObject({ id: 's0', open: false, status: 'CANCELED' });
    expect(a.calls[0]).toMatchObject({ where: { tenant_id: T, product_key: 'sign', source: 'SELF_SERVICE', ended_at: null } });
    expect(a.calls[1]).toMatchObject({ where: { tenant_id: T, product_key: 'sign', source: 'SELF_SERVICE' } });
    const svc = new BillingStatusReadService(stubPrisma({ open: ROW, latest: ROW }).prisma, new RecordingReader());
    await expect(svc.tenantBillingStatus(T, 'ats')).rejects.toBeInstanceOf(BillingStatusQueryError);
    await expect(svc.tenantBillingStatus(T, 'sign', { invoice_limit: 0 })).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
    await expect(svc.tenantBillingStatus(T, 'sign', { invoice_limit: 51 })).rejects.toMatchObject({ code: 'INVALID_LIMIT' });
  });

  it('C3-S-5 portal configuration: NOT_CONFIGURED, NOT_FOUND, INACTIVE, ACTIVE (a provider fact, not the §10 verification), and the disabled states', async () => {
    const saved = process.env['STRIPE_PORTAL_CONFIGURATION'];
    try {
      const r = new RecordingReader();
      const svc = new BillingStatusReadService(stubPrisma({ open: null, latest: null }).prisma, r);
      delete process.env['STRIPE_PORTAL_CONFIGURATION'];
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ availability: 'AVAILABLE', configuration_ref: null, configuration_state: 'NOT_CONFIGURED', configuration: null });
      process.env['STRIPE_PORTAL_CONFIGURATION'] = ' bpc_terms ';
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ configuration_ref: 'bpc_terms', configuration_state: 'NOT_FOUND' });
      const cfg: ProviderPortalConfigurationState = {
        provider: 'STRIPE',
        configuration_ref: 'bpc_terms',
        active: false,
        is_default: false,
        live: false,
        invoice_history_enabled: true,
        payment_method_update_enabled: true,
        subscription_cancel_enabled: true,
        subscription_cancel_mode: 'at_period_end',
        subscription_update_enabled: false,
      };
      r.portal = cfg;
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ configuration_state: 'INACTIVE' });
      r.portal = { ...cfg, active: true };
      const active = await svc.portalConfigurationStatus({ now: NOW });
      expect(active).toMatchObject({ availability: 'AVAILABLE', mode: 'test', configuration_state: 'ACTIVE', configuration: { active: true, subscription_cancel_mode: 'at_period_end', invoice_history_enabled: true } });
      expect(Object.keys(active)).not.toContain('verified');
      r.fail = new BillingProviderUnavailableError('down');
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ availability: 'PROVIDER_UNAVAILABLE', configuration_state: null });
      r.fail = null;
      r.live = true;
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ availability: 'LIVE_MODE_HELD', configuration_state: null });
      r.configured = false;
      delete process.env['STRIPE_PORTAL_CONFIGURATION'];
      expect(await svc.portalConfigurationStatus({ now: NOW })).toMatchObject({ availability: 'BILLING_UNAVAILABLE', configuration_state: 'NOT_CONFIGURED' });
    } finally {
      if (saved === undefined) delete process.env['STRIPE_PORTAL_CONFIGURATION'];
      else process.env['STRIPE_PORTAL_CONFIGURATION'] = saved;
    }
  });
});

describe('CCP-C3 invoice payment state (mirror of the provider status and dates)', () => {
  it('C3-U-1 the table', () => {
    const at = (o: Partial<ProviderInvoiceState>) => invoicePaymentState({ provider_status: 'open', amount_remaining_minor: 100, due_at: null, attempt_count: 0, ...o }, NOW);
    expect(at({ provider_status: 'draft' })).toBe('DRAFT');
    expect(at({ provider_status: 'paid' })).toBe('PAID');
    expect(at({ provider_status: 'uncollectible' })).toBe('UNCOLLECTIBLE');
    expect(at({ provider_status: 'void' })).toBe('VOID');
    expect(at({ provider_status: 'something_new' })).toBe('UNKNOWN');
    expect(at({})).toBe('DUE');
    expect(at({ amount_remaining_minor: 0 })).toBe('PAID');
    expect(at({ attempt_count: 2 })).toBe('PAYMENT_FAILED');
    expect(at({ due_at: new Date(NOW.getTime() - 1), attempt_count: 2 })).toBe('OVERDUE');
    // Due exactly now is not yet overdue (half-open, as TD-A2-1).
    expect(at({ due_at: NOW })).toBe('DUE');
  });
});
