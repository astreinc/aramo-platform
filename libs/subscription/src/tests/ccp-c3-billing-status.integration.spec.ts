import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type BillingProviderReadPort,
  BillingProviderUnavailableError,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
  type ProviderSubscriptionState,
} from '../lib/billing/billing-provider.port.js';
import { BillingStatusReadService } from '../lib/billing/billing-status-read.service.js';
import { STRIPE_READ_ADAPTER_METHODS } from '../lib/billing/stripe-billing-read.adapter.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { applyCcpA6Schema } from './support/ccp-a3-database.js';
import { newTenant, rawSubscription } from './support/ccp-a6.js';

// CCP-C3 (PBD §5.2 row C3) — the read-through on real Postgres 17 with a fake provider reader (no
// network, no key). It proves that the read writes NOTHING: every table in the subscription,
// entitlement and identity schemas hashes identically before and after every read. It also covers
// tenant and product isolation on real rows, and the designed state for a governed (MANUAL)
// subscription. Test IDs are cited by doc/ccp/slices/CCP-C3-acceptance.md.

const NOW = new Date('2026-10-26T12:00:00.000Z');

class FakeReader implements BillingProviderReadPort {
  readonly provider = 'STRIPE' as const;
  subs = new Map<string, ProviderSubscriptionState>();
  invoices = new Map<string, ProviderInvoiceState[]>();
  down = new Set<string>();
  calls: string[] = [];
  isConfigured() {
    return true;
  }
  mode(): 'test' | 'live' {
    return 'test';
  }
  async retrieveSubscription(ref: string) {
    this.calls.push(`retrieveSubscription:${ref}`);
    if (this.down.has(ref)) throw new BillingProviderUnavailableError('stripe read /v1/subscriptions: HTTP 503');
    const s = this.subs.get(ref);
    if (s === undefined) throw new BillingProviderUnavailableError('provider subscription not found', false);
    return s;
  }
  async listSubscriptionInvoices(ref: string, limit: number) {
    this.calls.push(`listSubscriptionInvoices:${ref}:${limit}`);
    return (this.invoices.get(ref) ?? []).slice(0, limit);
  }
  async retrievePortalConfiguration(): Promise<ProviderPortalConfigurationState | null> {
    this.calls.push('retrievePortalConfiguration');
    return null;
  }
  /** Provider state for a tenant's Stripe-owned row (account acct_<tenant>, as rawSubscription links it). */
  seed(tenant_id: string, ref: string, invoices: Array<Partial<ProviderInvoiceState>>): void {
    this.subs.set(ref, {
      provider: 'STRIPE',
      subscription_ref: ref,
      account_ref: `acct_${tenant_id}`,
      provider_status: 'past_due',
      current_period_start: new Date('2026-10-01T00:00:00Z'),
      current_period_end: new Date('2026-11-01T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: 'price_business',
      tenant_id,
      intent_id: null,
      account_country: 'US',
    });
    this.invoices.set(
      ref,
      invoices.map((o, i) => ({
        provider: 'STRIPE',
        invoice_ref: `in_${ref}_${i}`,
        number: null,
        account_ref: `acct_${tenant_id}`,
        subscription_ref: ref,
        provider_status: 'paid',
        currency: 'usd',
        total_minor: 4900,
        amount_due_minor: 4900,
        amount_paid_minor: 4900,
        amount_remaining_minor: 0,
        created_at: new Date('2026-10-01T00:00:00Z'),
        due_at: null,
        period_start: null,
        period_end: null,
        attempt_count: 1,
        next_attempt_at: null,
        hosted_url: null,
        document_url: null,
        live: false,
        ...o,
      })),
    );
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C3 read-through invoice and payment status (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let reader: FakeReader;
  let svc: BillingStatusReadService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    reader = new FakeReader();
    svc = new BillingStatusReadService(prisma, reader);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  /** One md5 per table in the schemas a billing read could touch (the no-write oracle). */
  async function dbFingerprint(): Promise<Record<string, string>> {
    const tables = await pg.query(
      `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
        WHERE table_schema IN ('subscription', 'entitlement', 'identity') AND table_type = 'BASE TABLE' ORDER BY 1, 2`,
    );
    const out: Record<string, string> = {};
    for (const { s, t } of tables.rows as Array<{ s: string; t: string }>) {
      const r = await pg.query(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${s}"."${t}" x`);
      out[`${s}.${t}`] = r.rows[0].h as string;
    }
    return out;
  }

  it('C3-I-1 AVAILABLE on a real Stripe-owned row: provider status + invoices with payment states; the database is byte-identical afterwards', async () => {
    const t = await newTenant(pg);
    const ref = `sub_${randomUUID().slice(0, 8)}`;
    const sub_id = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref, status: 'PAST_DUE' });
    reader.seed(t, ref, [{ provider_status: 'open', amount_paid_minor: 0, amount_remaining_minor: 4900, due_at: new Date('2026-10-20T00:00:00Z') }, {}]);
    const before = await dbFingerprint();
    expect(Object.keys(before).length).toBeGreaterThan(20);
    const s = await svc.tenantBillingStatus(t, 'sign', { now: NOW });
    expect(s).toMatchObject({ availability: 'AVAILABLE', product_key: 'sign', subscription: { id: sub_id, source: 'SELF_SERVICE', status: 'PAST_DUE', open: true, account_ref: `acct_${t}`, subscription_ref: ref } });
    expect(s.provider_subscription?.provider_status).toBe('past_due');
    expect(s.invoices.map((i) => i.payment_state)).toEqual(['OVERDUE', 'PAID']);
    // CCP-C5 — the designed disabled tax state on real Postgres.
    expect(s.tax).toEqual({ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' });
    await svc.portalConfigurationStatus({ now: NOW });
    expect(await dbFingerprint()).toEqual(before);
  });

  it('C3-I-2 a governed (MANUAL) subscription is never read through the provider: NO_PROVIDER_SUBSCRIPTION, 0 provider calls, database unchanged', async () => {
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'MANUAL' });
    const before = await dbFingerprint();
    const calls = reader.calls.length;
    expect(await svc.tenantBillingStatus(t, 'sign', { now: NOW })).toMatchObject({ availability: 'NO_PROVIDER_SUBSCRIPTION', subscription: null, invoices: [] });
    expect(await svc.tenantBillingStatus(await newTenant(pg), 'sign', { now: NOW })).toMatchObject({ availability: 'NO_PROVIDER_SUBSCRIPTION' });
    expect(reader.calls.length).toBe(calls);
    // (The second newTenant inserted a tenant: compare everything else.)
    const after = await dbFingerprint();
    for (const k of Object.keys(before)) if (k !== 'identity.Tenant') expect(after[k], k).toBe(before[k]);
  });

  it('C3-I-3 tenant isolation on real rows: each tenant reads only its own subscription; a provider row stamped for another tenant is TENANT_MISMATCH', async () => {
    const a = await newTenant(pg);
    const b = await newTenant(pg);
    const refA = `sub_a_${randomUUID().slice(0, 8)}`;
    const refB = `sub_b_${randomUUID().slice(0, 8)}`;
    await rawSubscription(pg, a, { source: 'SELF_SERVICE', ref: refA });
    await rawSubscription(pg, b, { source: 'SELF_SERVICE', ref: refB });
    reader.seed(a, refA, [{}]);
    reader.seed(b, refB, [{}, {}]);
    const sa = await svc.tenantBillingStatus(a, 'sign', { now: NOW });
    const sb = await svc.tenantBillingStatus(b, 'sign', { now: NOW });
    expect(sa.invoices.map((i) => i.subscription_ref)).toEqual([refA]);
    expect(sb.invoices.map((i) => i.subscription_ref)).toEqual([refB, refB]);
    expect(reader.calls.filter((c) => c.includes(refA)).every((c) => !c.includes(refB))).toBe(true);
    // The provider says refB belongs to tenant a: refused for b, with no provider data.
    reader.subs.set(refB, { ...(reader.subs.get(refB) as ProviderSubscriptionState), tenant_id: a });
    expect(await svc.tenantBillingStatus(b, 'sign', { now: NOW })).toMatchObject({ availability: 'TENANT_MISMATCH', provider_subscription: null, invoices: [] });
  });

  it('C3-I-4 the open row is read; after it ends, the most recent ended row is read; a provider failure is PROVIDER_UNAVAILABLE (no 5xx, no write)', async () => {
    const t = await newTenant(pg);
    const ref = `sub_e_${randomUUID().slice(0, 8)}`;
    const id = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref });
    reader.seed(t, ref, [{}]);
    expect((await svc.tenantBillingStatus(t, 'sign', { now: NOW })).subscription).toMatchObject({ id, open: true });
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = $2, status = 'CANCELED' WHERE id = $1`, [id, '2026-10-20T00:00:00Z']);
    const ended = await svc.tenantBillingStatus(t, 'sign', { now: NOW });
    expect(ended).toMatchObject({ availability: 'AVAILABLE', subscription: { id, open: false, status: 'CANCELED' } });
    reader.down.add(ref);
    const before = await dbFingerprint();
    expect(await svc.tenantBillingStatus(t, 'sign', { now: NOW })).toMatchObject({ availability: 'PROVIDER_UNAVAILABLE', subscription: { id }, invoices: [] });
    expect(await dbFingerprint()).toEqual(before);
  });

  it('C3-I-5 every provider call across the spec was a read-port read', () => {
    const ops = new Set(reader.calls.map((c) => c.split(':')[0]));
    for (const op of ops) expect((STRIPE_READ_ADAPTER_METHODS as readonly string[]).includes(op as string), op).toBe(true);
    expect(reader.calls.length).toBeGreaterThan(8);
  });
});
