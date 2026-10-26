import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllowanceService } from '../lib/allowance.service.js';
import {
  BillingProviderUnavailableError,
  type BillingProviderPort,
  type BillingProviderReadPort,
  type ProviderSubscriptionState,
} from '../lib/billing/billing-provider.port.js';
import { BillingFinanceReportService } from '../lib/billing/billing-finance-report.service.js';
import type { ProviderAdjustmentRequest } from '../lib/billing/billing-provider.port.js';
import { BillingStatusReadService } from '../lib/billing/billing-status-read.service.js';
import { STRIPE_READ_ADAPTER_METHODS, StripeBillingReadAdapter } from '../lib/billing/stripe-billing-read.adapter.js';
import { StripeBillingProvider } from '../lib/billing/stripe-billing.provider.js';
import { wireAccountParams, wireInvoiceState } from '../lib/billing/stripe-wire.js';
import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { TAX_NOT_ENABLED_REASON, taxAvailability } from '../lib/billing/tax-availability.js';
import type { CapacityService } from '../lib/capacity.service.js';
import { CommercialSubscriptionReadService } from '../lib/commercial/commercial-subscription-read.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CCP-C5 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C5; §10) — tax is a DESIGNED
// DISABLED STATE only until Stripe Tax registration. Row C5: "Tests: disabled-state tests";
// "HALT: any tax calculation before registration". No network and no real key.
//   C5-T-*  the state itself, and that no setting can enable it
//   C5-G-*  the no-tax-call guard: a source scan of every billing-provider client, and a fake
//           provider client that records EVERY provider request the two Stripe adapters can make
//   C5-D-*  the disabled state on every read that would show tax
// Test IDs are cited by doc/ccp/slices/CCP-C5-acceptance.md.

const DISABLED = { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' } as const;
const REPO = resolve(__dirname, '../../../..');
const BILLING = resolve(__dirname, '../lib/billing');

// Every environment name a future change might plausibly use to switch tax on. Set to "on" values
// while the state and the provider requests are observed: none may change anything.
const TAX_ENV_ON: Record<string, string> = {
  STRIPE_AUTOMATIC_TAX: '1',
  STRIPE_TAX: '1',
  STRIPE_TAX_ENABLED: 'true',
  TAX_ENABLED: 'true',
  BILLING_TAX_ENABLED: '1',
};

/** Any mention of tax in a provider parameter name, path, header or value. */
const hasTaxToken = (s: string): boolean => /tax/i.test(s);

/** Non-test TypeScript sources under a root (specs, tests and fixtures excluded). */
function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'tests' || n === 'test' || n === '__tests__' || n === 'fixtures') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.(spec|test)\.tsx?$/.test(n)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// The roots that hold billing code: the subscription lib and the two services that serve billing.
const BILLING_ROOTS = ['libs/subscription/src/lib', 'apps/sign-service/src/app', 'apps/platform-admin/src/app'].map((r) => resolve(REPO, r));

describe('CCP-C5 the tax state', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('C5-T-1 the state is always disabled with the registration reason, and every read gets a fresh object', () => {
    expect(TAX_NOT_ENABLED_REASON).toBe('STRIPE_TAX_NOT_REGISTERED');
    expect(taxAvailability()).toEqual(DISABLED);
    const a = taxAvailability();
    (a as { enabled: boolean }).enabled = true;
    expect(taxAvailability()).toEqual(DISABLED);
    expect(taxAvailability()).not.toBe(taxAvailability());
  });

  it('C5-T-2 no setting enables it: with every plausible tax switch set on, the state is unchanged', () => {
    Object.assign(process.env, TAX_ENV_ON);
    expect(taxAvailability()).toEqual(DISABLED);
  });

  it('C5-T-3 source: the state module is a constant (no env, settings or database read; no enabled=true anywhere)', () => {
    const src = readFileSync(resolve(BILLING, 'tax-availability.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env|import\s/);
    expect(src).not.toMatch(/enabled:\s*true/);
    expect(src.match(/enabled:\s*false/g)?.length).toBe(2);
  });

  it('C5-T-4 no env flag: no billing source reads an environment name containing TAX, and the prod operator contract has none', () => {
    const offenders: string[] = [];
    for (const f of BILLING_ROOTS.flatMap(sources)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/process\.env(?:\[\s*['"`]|\.)([A-Za-z0-9_]+)/g)) {
        if ((m[1] ?? '').split('_').some((seg) => /^TAX/i.test(seg))) offenders.push(`${relative(REPO, f)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    // The prod compose passthroughs and the operator contracts name no tax variable (the former
    // STRIPE_AUTOMATIC_TAX opt-in is removed; nothing replaces it).
    for (const f of ['docker-compose.prod.yml', '.env.prod.example', '.env.example']) {
      const names = [...readFileSync(resolve(REPO, f), 'utf8').matchAll(/^\s*(?:-\s+|#\s*)?([A-Z][A-Z0-9_]+)(?==|\s*$)/gm)].map((m) => m[1] ?? '');
      expect(names.filter((n) => n.split('_').some((seg) => /^TAX/.test(seg))), f).toEqual([]);
    }
  });
});

describe('CCP-C5 the no-tax-call guard — source scan', () => {
  it('C5-G-1 the scan covers every provider client: the only sources that read the Stripe key are the two Stripe adapters', () => {
    const readers = BILLING_ROOTS.flatMap(sources)
      .filter((f) => /process\.env\[['"]STRIPE_SECRET_KEY['"]\]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f))
      .sort();
    expect(readers).toEqual(['libs/subscription/src/lib/billing/stripe-billing-read.adapter.ts', 'libs/subscription/src/lib/billing/stripe-billing.provider.ts']);
    // And no other code anywhere in libs/ or apps/ talks to the provider API host.
    const hosts = ['libs', 'apps']
      .flatMap((r) => sources(resolve(REPO, r)))
      .filter((f) => /api\.stripe\.com/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f))
      .sort();
    expect(hosts).toEqual(['libs/subscription/src/lib/billing/stripe-billing-read.adapter.ts', 'libs/subscription/src/lib/billing/stripe-billing.provider.ts']);
  });

  it('C5-G-2 no billing source names a provider tax parameter or endpoint (calculation, collection, rates, ids or behaviour)', () => {
    const TAX_REQUEST = /automatic_tax|tax_rates?\b|default_tax_rates|tax_ids?\b|tax_id_collection|tax_behavior|tax_code|tax_exempt|\/v1\/tax\b|\/v1\/tax\/|\btaxRate|\btaxId|\bautomaticTax/;
    // The ONE allowed mention: the organization's own registration number in the tenant profile
    // (Sign Signup A1 §2.2), an identity column. It never reaches the billing-profile port or the
    // provider (C5-G-6 and C5-G-4 prove that).
    const ALLOWED: Record<string, string[]> = { 'apps/platform-admin/src/app/signup/sign-signup.service.ts': ['tax_id: o.tax_id,'] };
    const offenders: string[] = [];
    for (const f of BILLING_ROOTS.flatMap(sources)) {
      const rel = relative(REPO, f);
      const hits = readFileSync(f, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => TAX_REQUEST.test(l));
      const unexpected = hits.filter((l) => !(ALLOWED[rel] ?? []).includes(l));
      if (unexpected.length > 0) offenders.push(`${rel}: ${unexpected.join(' | ')}`);
      if (ALLOWED[rel] !== undefined) expect(hits, rel).toEqual(ALLOWED[rel]);
    }
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// The fake provider client: fetch is replaced, and every request the adapters make is recorded.
// ------------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  query: string[];
  body_keys: string[];
  body: string;
  headers: string[];
}

function methodNames(o: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = Object.getPrototypeOf(o); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor' && typeof (p as Record<string, unknown>)[n] === 'function') names.add(n);
  }
  return [...names].sort();
}

describe('CCP-C5 the no-tax-call guard — fake provider client on every provider call', () => {
  const env = { ...process.env };
  let recorded: Recorded[];

  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_c5';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_c5';
    process.env['STRIPE_API_BASE'] = 'http://provider.c5.test';
    // The removed opt-in and every other plausible switch are ON: they must stay inert.
    Object.assign(process.env, TAX_ENV_ON);
    recorded = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const body = typeof init.body === 'string' ? init.body : '';
        recorded.push({
          method: String(init.method),
          path: u.pathname,
          query: [...u.searchParams.keys()],
          body_keys: [...new URLSearchParams(body).keys()],
          body,
          headers: Object.keys((init.headers as Record<string, string>) ?? {}),
        });
        if (u.pathname === '/v1/invoices') return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
        return new Response(
          // Merge train (TD-MERGE-43): the generic object also carries a payment and an amount paid,
          // so the CCP-C4 refund calls reach every request they make. It names no paying account, so
          // the refund request below binds the empty account the wire mapper then reads.
          JSON.stringify({ id: 'obj_c5', url: 'https://provider.c5.test/session', status: 'active', active: true, metadata: { tenant_id: 't-c5' }, items: { data: [] }, payment_intent: 'pi_c5', currency: 'usd', amount_paid: 4900 }),
          { status: 200 },
        );
      }),
    );
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  const ADJ = { command_id: 'cmd-c5', tenant_id: 't-c5', currency: 'USD' };
  const ADJUSTMENTS: ProviderAdjustmentRequest[] = [
    { ...ADJ, operation: 'CREDIT_GRANT', target_ref: 'acct_c5', amount_minor: 500 },
    { ...ADJ, operation: 'CREDIT_REVERSE', target_ref: 'acct_c5', amount_minor: 500 },
    { ...ADJ, operation: 'DISCOUNT_APPLY', target_ref: 'sub_c5', discount_bps: 1000, coupon_ref: 'aramo-c5' },
    { ...ADJ, operation: 'DISCOUNT_REMOVE', target_ref: 'sub_c5', coupon_ref: 'aramo-c5' },
    { ...ADJ, operation: 'REFUND_CREATE', target_ref: 'in_c5', account_ref: '', amount_minor: 500 },
  ];
  // The provider calls each adapter can make, keyed by method (one or more invocations each).
  const PROVIDER_CALLS: Record<string, (p: StripeBillingProvider) => Promise<unknown>> = {
    upsertBillingAccount: async (p) => {
      const details = { tenant_id: 't-c5', legal_name: 'Acme LLC', billing_email: 'billing@acme.test', address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } };
      await p.upsertBillingAccount(null, details);
      await p.upsertBillingAccount('acct_c5', details);
    },
    createCheckoutSession: async (p) => {
      const req = { intent_id: 'i-c5', tenant_id: 't-c5', user_id: 'u-c5', user_email: 'owner@acme.test', price_ref: 'price_c5', success_url: 'https://e/ok', cancel_url: 'https://e/no' };
      await p.createCheckoutSession({ ...req, account_ref: null });
      await p.createCheckoutSession({ ...req, account_ref: 'acct_c5' });
    },
    createPortalSession: async (p) => {
      await p.createPortalSession('acct_c5', 'https://e/settings');
      await p.createPortalSession('acct_c5', 'https://e/settings', 'bpc_c5');
    },
    retrieveSubscription: (p) => p.retrieveSubscription('sub_c5'),
    cancelSubscription: async (p) => {
      await p.cancelSubscription('sub_c5', { at_period_end: true }, 'k-1');
      await p.cancelSubscription('sub_c5', { at_period_end: false }, 'k-2');
    },
    expireCheckoutSession: (p) => p.expireCheckoutSession('cs_c5', 'k-3'),
    retrieveCheckoutSession: (p) => p.retrieveCheckoutSession('cs_c5'),
    // Merge train (TD-MERGE-43, C5 x C4 / C4-P): the CCP-C4 billing-adjustment write, its re-read and
    // the C4-P payment picture, on every operation.
    executeAdjustment: async (p) => {
      for (const r of ADJUSTMENTS) await p.executeAdjustment(r, `k-${r.operation}`);
    },
    readAdjustmentEffect: async (p) => {
      for (const r of ADJUSTMENTS) {
        await p.readAdjustmentEffect(r, null);
        await p.readAdjustmentEffect(r, 'obj_c5');
      }
    },
    readPaymentPicture: (p) => p.readPaymentPicture('in_c5'),
  };
  const READ_CALLS: Record<string, (a: StripeBillingReadAdapter) => Promise<unknown>> = {
    retrieveSubscription: (a) => a.retrieveSubscription('sub_c5'),
    listSubscriptionInvoices: (a) => a.listSubscriptionInvoices('sub_c5', 12),
    retrievePortalConfiguration: (a) => a.retrievePortalConfiguration('bpc_c5'),
  };
  // Methods that make no provider request (local state, or the inbound webhook check).
  const PROVIDER_LOCAL = ['isConfigured', 'mode', 'verifyWebhook'];
  const PRIVATE = ['secretKey', 'base', 'call', 'read'];

  it('C5-G-3 the guard exercises EVERY provider-calling method of both Stripe adapters (a new method fails here until it is covered)', () => {
    const provider = methodNames(new StripeBillingProvider()).filter((m) => !PROVIDER_LOCAL.includes(m) && !PRIVATE.includes(m));
    expect(provider).toEqual(Object.keys(PROVIDER_CALLS).sort());
    const reader = methodNames(new StripeBillingReadAdapter()).filter((m) => !PROVIDER_LOCAL.includes(m) && !PRIVATE.includes(m));
    expect(reader).toEqual(Object.keys(READ_CALLS).sort());
    expect([...STRIPE_READ_ADAPTER_METHODS].filter((m) => !PROVIDER_LOCAL.includes(m)).sort()).toEqual(Object.keys(READ_CALLS).sort());
  });

  it('C5-G-4 no recorded provider request asks for tax: no tax path, query, form parameter or value, on any method and branch', async () => {
    const p = new StripeBillingProvider();
    for (const call of Object.values(PROVIDER_CALLS)) await call(p);
    const a = new StripeBillingReadAdapter();
    for (const call of Object.values(READ_CALLS)) await call(a);

    // Every call above reached the fake client: the C1-era 11 provider requests + 3 read requests,
    // plus (merge train TD-MERGE-43) the CCP-C4 / C4-P 22: executeAdjustment 7 (credit grant /
    // reverse 1 each, discount apply 2 (coupon + subscription), discount remove 1, refund 2 (invoice
    // re-verify + refund)), readAdjustmentEffect 12 (2 reads each for the 2 credit, 2 discount and
    // refund operations: credit 1 + 1, discount 1 + 1, refund 2 + 2) and readPaymentPicture 3.
    expect(recorded.length).toBe(36);
    for (const w of ['POST /v1/refunds', 'POST /v1/coupons', 'GET /v1/disputes', 'GET /v1/refunds']) expect(recorded.map((r) => `${r.method} ${r.path}`), w).toContain(w);
    expect(new Set(recorded.map((r) => `${r.method} ${r.path}`)).size).toBeGreaterThanOrEqual(9);
    for (const r of recorded) {
      const where = `${r.method} ${r.path}`;
      expect(hasTaxToken(r.path), where).toBe(false);
      expect(r.query.filter(hasTaxToken), where).toEqual([]);
      expect(r.body_keys.filter(hasTaxToken), where).toEqual([]);
      expect(r.body, where).not.toMatch(/tax/i);
      expect(r.headers.filter(hasTaxToken), where).toEqual([]);
    }
    // The checkout create (the request the removed opt-in used to touch) is observed on both branches.
    expect(recorded.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').length).toBe(2);
  });

  it('C5-G-5 the provider-call fake fails loudly on a tax parameter (the guard is not vacuous)', () => {
    expect(hasTaxToken('automatic_tax[enabled]')).toBe(true);
    expect(hasTaxToken('subscription_data[default_tax_rates][0]')).toBe(true);
    expect(hasTaxToken('tax_id_collection[enabled]')).toBe(true);
    expect(hasTaxToken('/v1/tax/calculations')).toBe(true);
    expect(hasTaxToken('line_items[0][price]')).toBe(false);
    expect(hasTaxToken('billing_address_collection')).toBe(false);
  });

  it('C5-G-6 no tax figure is read: the invoice mirror drops every provider tax field', () => {
    const inv = wireInvoiceState({ id: 'in_c5', status: 'open', total: 1000, tax: 80, total_tax_amounts: [{ amount: 80 }], automatic_tax: { enabled: false }, default_tax_rates: [] });
    expect(Object.keys(inv).filter(hasTaxToken)).toEqual([]);
    expect(JSON.stringify(inv)).not.toMatch(/tax/i);
  });

  it('C5-G-7 the organization registration number never reaches the provider: the billing-profile port and the account params carry no tax field', () => {
    const port = readFileSync(resolve(BILLING, 'organization-billing-profile.port.ts'), 'utf8');
    expect(port).not.toMatch(/tax/i);
    const details = { tenant_id: 't-c5', legal_name: 'Acme LLC', billing_email: 'b@acme.test', address: { line1: '1', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' }, tax_id: '12-3456789' };
    const params = wireAccountParams(details);
    expect(Object.keys(params).filter(hasTaxToken)).toEqual([]);
    expect(Object.values(params)).not.toContain('12-3456789');
  });
});

// ------------------------------------------------------------------------------------------------
// C5-D — the disabled state on every read that would show tax.
// ------------------------------------------------------------------------------------------------

function fakeReader(over: Partial<BillingProviderReadPort> = {}): BillingProviderReadPort {
  const ps: ProviderSubscriptionState = {
    provider: 'STRIPE',
    subscription_ref: 'sub_c5',
    account_ref: 'acct_c5',
    provider_status: 'active',
    current_period_start: new Date('2026-10-01T00:00:00Z'),
    current_period_end: new Date('2026-11-01T00:00:00Z'),
    cancel_at_period_end: false,
    price_ref: 'price_c5',
    tenant_id: 't-c5',
    intent_id: null,
    account_country: 'US',
  };
  return {
    provider: 'STRIPE',
    isConfigured: () => true,
    mode: () => 'test',
    retrieveSubscription: async () => ps,
    listSubscriptionInvoices: async () => [],
    retrievePortalConfiguration: async () => null,
    ...over,
  } as BillingProviderReadPort;
}

const SELF_SERVICE_ROW = { id: 'ts-c5', source: 'SELF_SERVICE', status: 'ACTIVE', ended_at: null, billing_account_ref: 'acct_c5', billing_subscription_ref: 'sub_c5' };
const statusPrisma = (row: unknown) => ({ tenantSubscription: { findFirst: async () => row } }) as unknown as PrismaService;

/** A read-only snapshot fake: every raw query answers [], except the tenant lookup. */
function snapshotPrisma(tenant: unknown | null = null): PrismaService {
  const tx = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async (sql: string) => (tenant !== null && /FROM identity\."Tenant" WHERE id = \$1::uuid/.test(sql) ? [tenant] : []),
  };
  return { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaService;
}

const fakeBilling = (configured: boolean, mode: 'test' | 'live' = 'test') => ({ provider: 'STRIPE', isConfigured: () => configured, mode: () => mode }) as unknown as BillingProviderPort;

describe('CCP-C5 disabled-state tests', () => {
  const env = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, TAX_ENV_ON);
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('C5-D-1 C3 tenant billing status: tax is disabled on every availability', async () => {
    const T = 't-c5';
    const cases: Array<[string, BillingStatusReadService]> = [
      ['BILLING_UNAVAILABLE', new BillingStatusReadService(statusPrisma(SELF_SERVICE_ROW), fakeReader({ isConfigured: () => false }))],
      ['LIVE_MODE_HELD', new BillingStatusReadService(statusPrisma(SELF_SERVICE_ROW), fakeReader({ mode: () => 'live' }))],
      ['NO_PROVIDER_SUBSCRIPTION', new BillingStatusReadService(statusPrisma(null), fakeReader())],
      ['TENANT_MISMATCH', new BillingStatusReadService(statusPrisma(SELF_SERVICE_ROW), fakeReader({ retrieveSubscription: async () => ({ ...(await fakeReader().retrieveSubscription('x')), tenant_id: 'other' }) }))],
      ['PROVIDER_UNAVAILABLE', new BillingStatusReadService(statusPrisma(SELF_SERVICE_ROW), fakeReader({ retrieveSubscription: async () => { throw new BillingProviderUnavailableError('down', true); } }))],
      ['AVAILABLE', new BillingStatusReadService(statusPrisma(SELF_SERVICE_ROW), fakeReader())],
    ];
    for (const [availability, svc] of cases) {
      const s = await svc.tenantBillingStatus(T, 'sign');
      expect(s.availability, availability).toBe(availability);
      expect(s.tax, availability).toEqual(DISABLED);
    }
  });

  it('C5-D-2 C6 Finance reports: renewals, outstanding payments and the reconciliation report each carry the disabled state (provider configured or not)', async () => {
    for (const billing of [fakeBilling(false), fakeBilling(true), fakeBilling(true, 'live')]) {
      const svc = new BillingFinanceReportService(snapshotPrisma(), billing);
      expect((await svc.renewals()).tax).toEqual(DISABLED);
      expect((await svc.outstandingPayments()).tax).toEqual(DISABLED);
      expect((await svc.reconciliationReport()).tax).toEqual(DISABLED);
    }
  });

  it('C5-D-3 B3 tenant Commercial overview carries the disabled state (and an unknown tenant stays null)', async () => {
    const svc = new CommercialSubscriptionReadService(snapshotPrisma({ id: 't-c5', name: 'Acme', slug: 'acme', kind: 'BUSINESS' }));
    const o = await svc.tenantOverview('t-c5');
    expect(o).not.toBeNull();
    expect(o?.tax).toEqual(DISABLED);
    expect(await new CommercialSubscriptionReadService(snapshotPrisma()).tenantOverview('t-none')).toBeNull();
  });

  it('C5-D-4 the tenant Sign billing account read carries the disabled state (with or without a subscription, billing configured or not)', async () => {
    const prisma = { tenantSubscription: { findFirst: async () => null }, planVersionPrice: { count: async () => 0 } } as unknown as PrismaService;
    const allowance = { getStatus: async () => ({ subscribed: false, allowance_key: 'sign.envelopes', state: 'NONE' }) } as unknown as AllowanceService;
    const capacity = { status: async () => ({ subscribed: false, capacity_key: 'sign.storage', limit: null, unlimited: false, used: 0 }) } as unknown as CapacityService;
    for (const billing of [fakeBilling(false), fakeBilling(true)]) {
      const svc = new SubscriptionLifecycleService(prisma, allowance, billing, capacity);
      const view = await svc.account('t-c5', 'sign', 'sign.envelopes');
      expect(view.tax).toEqual(DISABLED);
    }
  });
});
