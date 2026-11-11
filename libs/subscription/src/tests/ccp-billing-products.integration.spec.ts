import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BillingInterval, BillingProvider } from '../lib/billing/sync/billing-product.js';
import { BillingProductsService } from '../lib/billing/sync/billing-products.service.js';
import { BillingSyncError, type BillingProductSyncPort, type BillingSyncOutcome, type BillingSyncTarget } from '../lib/billing/sync/billing-sync.port.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialChangeRequestError, CommercialChangeRequestService } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { currentPublishedVersion } from '../lib/plan-version.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, a6Harness, as, type A6Harness } from './support/ccp-a6.js';

// CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED) — the whole chain on real
// Postgres 17: the migration (BillingProduct / BillingProductSync / BillingAsset, their triggers), the
// publish-time rules at request creation (BP-2 / BP-3 / BP-7 / BP-11), the governed Finance → Owner chain,
// the apply enqueueing one job per product in its own transaction (BP-10, nothing sent to a provider),
// the worker draining them with SKIP LOCKED leases, the permanent ids and purchase links written only on
// provider success, the failure states (transient backoff, not configured, needs attention), Retry, and
// the status view. The three providers are in-memory fakes (their clients have their own specs).

const T0 = new Date('2026-11-11T12:00:00.000Z');
const PERSONAL = 'aramo-sign-standard-personal-v1';
const APPLE_ID = 'ai.aramo.sign.personal_standard.monthly';

class FakeProvider implements BillingProductSyncPort {
  calls: BillingSyncTarget[] = [];
  fail: BillingSyncError | null = null;
  configuredFlag = true;
  constructor(
    readonly provider: BillingProvider,
    private readonly outcome: (t: BillingSyncTarget) => Partial<BillingSyncOutcome>,
  ) {}
  configured(): boolean {
    return this.configuredFlag;
  }
  async sync(t: BillingSyncTarget): Promise<BillingSyncOutcome> {
    this.calls.push(t);
    if (this.fail !== null) throw this.fail;
    return { status: 'SYNCED', origin: 'CREATED', external_ref: null, external_price_ref: null, store_state: null, detail: null, ...this.outcome(t) };
  }
  async preview(t: BillingSyncTarget) {
    return t.prices.map((p) => ({ ...p, available: true, nearest: [] }));
  }
  async liveCountries(): Promise<string[] | null> {
    return null;
  }
  async livePrices(t: Pick<BillingSyncTarget, 'prices'>) {
    return t.prices.map((p) => ({ country: p.country, currency: p.currency, amount_minor: p.amount_minor }));
  }
}

/** A PNG header of an iPhone 6.7" screenshot (1290 × 2796): enough for the size check. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP Billing Products — publish, apply and sync (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let billing: BillingProductsService;
  let cr: CommercialChangeRequestService;
  let CAT: string;
  let FA: string;
  let PO: string;
  let keyN = 0;
  let now = T0;
  const key = () => `bp-key-${String(++keyN).padStart(6, '0')}`;
  const stripe = new FakeProvider('STRIPE', (t) => ({ external_price_ref: `price_test_${t.version_number}` }));
  const apple = new FakeProvider('APP_STORE', () => ({ origin: 'ADOPTED', external_ref: '6832501043', store_state: 'READY_TO_SUBMIT', detail: 'manual review step' }));
  const play = new FakeProvider('GOOGLE_PLAY', () => ({ store_state: 'ACTIVE' }));

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => now);
    billing = new BillingProductsService(prisma, h.versions, [stripe, apple, play], () => now);
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    cr = new CommercialChangeRequestService(prisma, audit, policies, new CommercialOperatorRepository(prisma, audit, policies), () => now, undefined, billing);
    CAT = await addOperator(pg, ['catalog_manager']);
    FA = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const planId = async (k: string) => (await prisma.plan.findUniqueOrThrow({ where: { key: k } })).id;
  async function draft(plan_key: string): Promise<string> {
    const plan_id = await planId(plan_key);
    return (await h.versions.createDraft({ plan_id, content: await h.versions.liveContent(plan_id), created_by: 'bp-test' })).id;
  }
  // A1-1 — every request below carries the store listing unless a test removes it.
  const LISTING = { name: 'Standard', description: '25 sends a month and 1 GB storage' };
  const withListing = (payload: Record<string, unknown>) => {
    const bp = payload['billing_products'] as Record<string, unknown> | undefined;
    return bp === undefined || 'listing' in bp ? payload : { ...payload, billing_products: { ...bp, listing: LISTING } };
  };
  const create = (payload: Record<string, unknown>) => createRaw(withListing(payload));
  const createRaw = (payload: Record<string, unknown>) => cr.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_VERSION_PUBLISH', payload, reason: 'billing products', idempotency_key: key() }, A6_CTX);
  async function approveAndApply(id: string): Promise<void> {
    await h.changeRequests.submit(as(CAT, 'catalog_manager'), id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    await h.changeRequests.approve(as(PO, 'platform_owner'), id, { step_index: 1 }, A6_CTX);
    await h.apply.apply(as(CAT, 'catalog_manager'), id, A6_CTX);
  }
  async function refusal(p: Promise<unknown>): Promise<string[]> {
    try {
      await p;
      return [];
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) return ((e.details as { codes?: string[] }).codes ?? [e.code]).slice().sort();
      throw e;
    }
  }
  const products = (...p: [BillingProvider, string][]) => p.map(([provider, product_id]) => ({ provider, interval: 'MONTH' as BillingInterval, product_id }));

  let v2: string;
  let shot: string;

  it('BP-2 / BP-7: refuses app channels on a Business plan and a new App Store product without the screenshot', async () => {
    const b = await draft(BUSINESS);
    expect(await refusal(create({ plan_version_id: b, billing_products: { products: products(['STRIPE', 'aramo_sign_business_standard'], ['APP_STORE', 'ai.aramo.sign.business_standard.monthly']) } }))).toEqual(['PROVIDER_NOT_ELIGIBLE', 'SCREENSHOT_REQUIRED']);
    v2 = await draft(PERSONAL);
    expect(await refusal(create({ plan_version_id: v2, billing_products: { products: products(['APP_STORE', APPLE_ID]) } }))).toEqual(['SCREENSHOT_REQUIRED']);
    // A1-1 — a store product needs the store listing, within Apple's limits (the 77-character plan description is refused).
    expect(await refusal(createRaw({ plan_version_id: v2, billing_products: { products: products(['GOOGLE_PLAY', APPLE_ID]) } }))).toEqual(['LISTING_REQUIRED']);
    const long = await createRaw({ plan_version_id: v2, billing_products: { products: products(['GOOGLE_PLAY', APPLE_ID]), listing: { name: 'Standard', description: 'x'.repeat(77) } } }).catch((e: unknown) => e);
    expect(String((long as Error).message) + JSON.stringify((long as { details?: unknown }).details ?? {})).toMatch(/1 to 45 characters/);
  });

  it('BP-7: stores the review screenshot only at an iPhone size', async () => {
    await expect(billing.uploadReviewScreenshot({ plan_id: await planId(PERSONAL), file_name: 'x.png', content_type: 'image/png', bytes: pngHeader(945, 2048), created_by: CAT })).rejects.toThrow(/iPhone screenshot size/);
    shot = (await billing.uploadReviewScreenshot({ plan_id: await planId(PERSONAL), file_name: 'plans.png', content_type: 'image/png', bytes: pngHeader(1290, 2796), created_by: CAT })).id;
    await expect(pg.query(`UPDATE subscription."BillingAsset" SET file_name = 'x' WHERE id = $1`, [shot])).rejects.toThrow(/immutable/);
  });

  it('BP-10: the approved publish enqueues one job per product and sends nothing; the worker syncs, then links', async () => {
    const r = await create({ plan_version_id: v2, billing_products: { products: products(['STRIPE', 'aramo_sign_personal_standard'], ['APP_STORE', APPLE_ID], ['GOOGLE_PLAY', APPLE_ID]), apple_review_screenshot_asset_id: shot } });
    await approveAndApply(r.request.id);
    expect(stripe.calls.length + apple.calls.length + play.calls.length).toBe(0);
    const jobs = await prisma.billingProductSync.findMany({ where: { change_request_id: r.request.id } });
    expect(jobs.map((j) => [j.provider, j.status]).sort()).toEqual([['APP_STORE', 'PENDING'], ['GOOGLE_PLAY', 'PENDING'], ['STRIPE', 'PENDING']]);
    expect((await prisma.commercialCatalogApplication.findUniqueOrThrow({ where: { change_request_id: r.request.id } })).billing_products).toMatchObject({ apple_review_screenshot_asset_id: shot });
    expect(await prisma.planVersionPrice.count({ where: { plan_version_id: v2 } })).toBe(0);
    expect((await currentPublishedVersion(prisma, await planId(PERSONAL)))?.id).toBe(v2);

    expect(await billing.drain()).toBe(3);
    expect(stripe.calls[0]).toMatchObject({ product_id: 'aramo_sign_personal_standard', prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }], display_name: 'Standard', description: '25 sends a month and 1 GB storage', stop_countries: [] });
    expect(apple.calls[0]?.review_screenshot?.bytes.byteLength).toBe(33);
    expect(play.calls[0]?.review_screenshot).toBeNull();
    const pins = await prisma.planVersionPrice.findMany({ where: { plan_version_id: v2 }, orderBy: { provider: 'asc' } });
    expect(pins.map((p) => [p.provider, p.provider_price_ref])).toEqual([['APP_STORE', APPLE_ID], ['GOOGLE_PLAY', APPLE_ID], ['STRIPE', 'price_test_2']]);
    const permanent = await prisma.billingProduct.findMany({ orderBy: { provider: 'asc' } });
    expect(permanent.map((p) => [p.provider, p.product_id, p.origin, p.external_ref])).toEqual([
      ['APP_STORE', APPLE_ID, 'ADOPTED', '6832501043'],
      ['GOOGLE_PLAY', APPLE_ID, 'CREATED', null],
      ['STRIPE', 'aramo_sign_personal_standard', 'CREATED', null],
    ]);
    const view = await billing.status(v2);
    expect(view.map((v) => [v.provider, v.linked, v.sync?.status, v.sync?.store_state])).toEqual([
      ['APP_STORE', true, 'SYNCED', 'READY_TO_SUBMIT'],
      ['GOOGLE_PLAY', true, 'SYNCED', 'ACTIVE'],
      ['STRIPE', true, 'SYNCED', null],
    ]);
    expect(await billing.drain()).toBe(0);
    await expect(pg.query(`UPDATE subscription."BillingProduct" SET product_id = 'x' WHERE provider = 'STRIPE'`)).rejects.toThrow(/permanent/);
    await expect(pg.query(`UPDATE subscription."BillingProductSync" SET status = 'PENDING' WHERE change_request_id = $1`, [r.request.id])).rejects.toThrow(/final/);
  });

  it('BP-3 / BP-11: ids are permanent and every sold channel is carried forward or explicitly stopped', async () => {
    const v3 = await draft(PERSONAL);
    expect(await refusal(create({ plan_version_id: v3 }))).toEqual(['CHANNEL_DROPPED']);
    expect(await refusal(create({ plan_version_id: v3, billing_products: { products: products(['STRIPE', 'aramo_sign_personal_standard'], ['APP_STORE', 'ai.aramo.sign.other.monthly'], ['GOOGLE_PLAY', APPLE_ID]) } }))).toEqual(['PRODUCT_ID_PERMANENT']);
    expect(await refusal(create({ plan_version_id: v3, billing_products: { products: products(['STRIPE', 'aramo_sign_personal_standard'], ['APP_STORE', APPLE_ID]) } }))).toEqual(['CHANNEL_DROPPED']);
    const carry = await billing.carryForward(await planId(PERSONAL));
    expect(carry.products.map((p) => [p.provider, p.product_id]).sort()).toEqual([['APP_STORE', APPLE_ID], ['GOOGLE_PLAY', APPLE_ID], ['STRIPE', 'aramo_sign_personal_standard']]);

    const r = await create({ plan_version_id: v3, billing_products: { products: products(['STRIPE', 'aramo_sign_personal_standard'], ['APP_STORE', APPLE_ID]), stop_selling: ['GOOGLE_PLAY'] } });
    await approveAndApply(r.request.id);
    // Failure states: a transient Apple error backs off, Stripe needs a person, Google is gone from this version.
    apple.fail = new BillingSyncError('TRANSIENT', 'HTTP 503');
    stripe.fail = new BillingSyncError('PRICE_POINT_UNAVAILABLE', 'no exact point', false);
    expect(await billing.drain()).toBe(2);
    const byProvider = async () => Object.fromEntries((await prisma.billingProductSync.findMany({ where: { change_request_id: r.request.id } })).map((j) => [j.provider, j]));
    let jobs = await byProvider();
    expect(jobs['APP_STORE']).toMatchObject({ status: 'FAILED', attempts: 1, last_error: 'HTTP 503' });
    expect(jobs['APP_STORE']?.next_attempt_at.getTime()).toBe(T0.getTime() + 60_000);
    expect(jobs['STRIPE']).toMatchObject({ status: 'NEEDS_ATTENTION', last_error: 'no exact point' });
    expect(jobs['GOOGLE_PLAY']).toBeUndefined();
    expect(await prisma.planVersionPrice.count({ where: { plan_version_id: v3 } })).toBe(0);

    // Not due yet; then due: Apple succeeds; Stripe waits for a person (Retry) and then succeeds.
    expect(await billing.drain()).toBe(0);
    now = new Date(T0.getTime() + 61_000);
    apple.fail = null;
    stripe.fail = null;
    expect(await billing.drain()).toBe(1);
    await expect(billing.retry(jobs['APP_STORE']!.id)).rejects.toThrow(/not retried/);
    await billing.retry(jobs['STRIPE']!.id);
    expect(await billing.drain()).toBe(1);
    jobs = await byProvider();
    expect([jobs['APP_STORE']?.status, jobs['STRIPE']?.status]).toEqual(['SYNCED', 'SYNCED']);
    expect((await prisma.planVersionPrice.findMany({ where: { plan_version_id: v3 } })).map((p) => p.provider).sort()).toEqual(['APP_STORE', 'STRIPE']);
  });

  it('a provider without credentials waits as NOT_CONFIGURED and syncs once configured', async () => {
    const v4 = await draft(PERSONAL);
    play.configuredFlag = false;
    const r = await create({ plan_version_id: v4, billing_products: { products: products(['STRIPE', 'aramo_sign_personal_standard'], ['APP_STORE', APPLE_ID], ['GOOGLE_PLAY', APPLE_ID]) } });
    await approveAndApply(r.request.id);
    await billing.drain();
    const g = await prisma.billingProductSync.findFirstOrThrow({ where: { change_request_id: r.request.id, provider: 'GOOGLE_PLAY' } });
    expect(g).toMatchObject({ status: 'NOT_CONFIGURED' });
    play.configuredFlag = true;
    now = new Date(now.getTime() + 3_600_001);
    expect(await billing.drain()).toBe(1);
    expect((await prisma.billingProductSync.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('SYNCED');
  });
});
