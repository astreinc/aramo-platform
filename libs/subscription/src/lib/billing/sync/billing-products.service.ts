import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { currentPublishedVersion, PlanVersionRepository, PlanVersionStateError } from '../../plan-version.repository.js';
import { planVersionTerms } from '../../plan-version.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import {
  billingProductsRuleErrors,
  defaultProductId,
  eligibleProviders,
  type BillingInterval,
  type BillingProductsPayload,
  type BillingProductsRuleError,
  type BillingProvider,
} from './billing-product.js';
import {
  BillingSyncError,
  type BillingProductSyncPort,
  type BillingSyncTarget,
  type BillingTargetPrice,
  type LiveProviderPrice,
  type PreviewProviderPrice,
  unconfirmedDrops,
} from './billing-sync.port.js';
import { appleTerritory } from './apple-territories.js';
import { enqueueBillingProductSync } from './billing-sync-enqueue.js';
import { imageDimensions, reviewScreenshotDimensionsError } from './review-screenshot.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.3 — the billing-products service:
//   validateForPublish  BP-2 / BP-3 / BP-7 / BP-11 rules + BP-5 exact-price preview, at request creation
//   enqueue             BP-10: one BillingProductSync job per product, inside the governed apply transaction
//   drain               the platform-admin worker: lease, sync with the provider, then (only on success)
//                       the permanent BillingProduct row and the purchase link (PlanVersionPrice)
//   retry / status / preview / mismatchReport (BP-12) / uploadReviewScreenshot (BP-7)
// Nothing is sent to a provider before the change request is approved and applied.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export type BillingSyncStatus = 'PENDING' | 'SYNCED' | 'NEEDS_ATTENTION' | 'FAILED' | 'NOT_CONFIGURED';

/** Backoff of a transient failure; after the last step a person is needed (NEEDS_ATTENTION). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000];
/** A provider that is not configured is re-checked hourly (it syncs once its credentials are set). */
const NOT_CONFIGURED_RECHECK_MS = 3_600_000;
const LEASE_MS = 5 * 60_000;

export class BillingProductsError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'NOT_RETRYABLE',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BillingProductsError';
  }
}

export interface BillingProductView {
  provider: BillingProvider;
  interval: BillingInterval;
  product_id: string;
  origin: 'CREATED' | 'ADOPTED' | null;
  sync: null | {
    id: string;
    change_request_id: string;
    plan_version_id: string;
    status: BillingSyncStatus;
    attempts: number;
    store_state: string | null;
    last_error: string | null;
    synced_at: string | null;
    next_attempt_at: string;
  };
  /** The purchase link on THIS version (the channel sells it). */
  linked: boolean;
}

export interface MismatchEntry {
  plan_key: string;
  plan_version_id: string;
  provider: BillingProvider;
  interval: BillingInterval;
  product_id: string;
  country: string;
  currency: string;
  catalog_amount_minor: number;
  live_amount_minor: number | null;
  status: 'MATCH' | 'MISMATCH' | 'MISSING_IN_STORE' | 'STORE_PRICE_UNAVAILABLE';
}

@Injectable()
export class BillingProductsService {
  private readonly log = new Logger(BillingProductsService.name);
  private readonly ports: Map<BillingProvider, BillingProductSyncPort>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: PlanVersionRepository,
    ports: readonly BillingProductSyncPort[],
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.ports = new Map(ports.map((p) => [p.provider, p]));
  }

  // ---- request creation (BP-2 / BP-3 / BP-5 / BP-7 / BP-11) -----------------------------------

  /** The rule errors of a PLAN_VERSION_PUBLISH's billing products (empty = may be requested). */
  async validateForPublish(plan_version_id: string, payload: BillingProductsPayload | undefined): Promise<BillingProductsRuleError[]> {
    const version = await this.prisma.planVersion.findUnique({ where: { id: plan_version_id }, include: { plan: true } });
    if (version === null) return [];
    const plan = { tenant_kind: version.plan.tenant_kind, sales_model: version.plan.sales_model };
    const sold = await this.soldChannels(version.plan_id);
    if (payload === undefined) {
      // A publish without billing products would silently stop every channel the plan sells on (BP-11).
      return sold.length === 0
        ? []
        : [{ code: 'CHANNEL_DROPPED', message: `the plan sells on ${sold.map((s) => s.provider).join(', ')}; the publish must carry its billing products` }];
    }
    const existing = (await this.prisma.billingProduct.findMany({ where: { plan_id: version.plan_id } })).map(asLink);
    const taken = payload.products.length === 0
      ? []
      : (await this.prisma.billingProduct.findMany({ where: { plan_id: { not: version.plan_id }, OR: payload.products.map((p) => ({ provider: p.provider, product_id: p.product_id })) } })).map(asLink);
    const errors = billingProductsRuleErrors({ payload, plan, existing, taken_elsewhere: taken, sold });
    // A1-2 — the App Store sells only in its territories, each in one currency; a stop country cannot also carry a price.
    const regional = planVersionTerms(version).regional_prices ?? [];
    for (const p of payload.products.filter((x) => x.provider === 'APP_STORE')) {
      for (const r of regional.filter((x) => x.interval === p.interval)) {
        const terr = appleTerritory(r.country);
        if (terr === null) errors.push({ code: 'COUNTRY_NOT_SOLD', message: `the App Store does not sell in ${r.country}; remove that regional price or untick the App Store` });
        else if (terr.currency !== r.currency) errors.push({ code: 'COUNTRY_NOT_SOLD', message: `the App Store charges ${terr.currency} in ${r.country}; the regional price is in ${r.currency}` });
      }
    }
    for (const c of payload.stop_countries ?? []) {
      if (regional.some((r) => r.country === c)) errors.push({ code: 'STOP_COUNTRY_PRICED', message: `${c} has a regional price on this version, so it keeps selling there; remove the price or the stop` });
    }
    const assetId = payload.apple_review_screenshot_asset_id;
    if (assetId !== undefined) {
      const asset = await this.prisma.billingAsset.findUnique({ where: { id: assetId }, select: { plan_id: true, kind: true } });
      if (asset === null || asset.plan_id !== version.plan_id || asset.kind !== 'APPLE_REVIEW_SCREENSHOT') {
        errors.push({ code: 'SCREENSHOT_REQUIRED', message: 'the review screenshot was not uploaded for this plan' });
      }
    }
    // BP-5 — never rounded: a store without the exact amount refuses the request now (when it can be checked).
    if (errors.length === 0) {
      for (const p of payload.products) {
        const port = this.ports.get(p.provider);
        if (port === undefined || !port.configured()) continue;
        const preview = await port.preview(await this.targetFor(version.id, p.provider, p.interval, p.product_id, null, payload));
        const missing = preview.filter((x) => !x.available);
        for (const m of missing) {
          errors.push({ code: 'PRICE_NOT_AVAILABLE', message: `${p.provider} has no price of exactly ${m.amount_minor} ${m.currency} (minor units) in ${m.country}; nearest: ${m.nearest.join(', ') || 'none'}` });
        }
      }
    }
    return errors;
  }

  /** BP-5 — the exact per-channel, per-country prices the sync would set (the approver's preview). */
  async preview(plan_version_id: string, products: BillingProductsPayload['products']): Promise<{ provider: BillingProvider; interval: BillingInterval; product_id: string; configured: boolean; prices: PreviewProviderPrice[]; stops: string[]; error: string | null }[]> {
    const out = [];
    for (const p of products) {
      const port = this.ports.get(p.provider);
      if (port === undefined || !port.configured()) {
        out.push({ ...p, configured: false, prices: [], stops: [], error: null });
        continue;
      }
      try {
        const target = await this.targetFor(plan_version_id, p.provider, p.interval, p.product_id, null);
        // A1-2 — the countries the store sells in today that this version has no price for (the approver confirms each stop).
        const stops = unconfirmedDrops(await port.liveCountries(target), target);
        out.push({ ...p, configured: true, prices: await port.preview(target), stops, error: null });
      } catch (e) {
        out.push({ ...p, configured: true, prices: [], stops: [], error: e instanceof BillingSyncError ? e.message : 'preview unavailable' });
      }
    }
    return out;
  }

  /** BP-7 — store the Apple review screenshot (PNG / JPEG of an accepted iPhone size) for a plan. */
  async uploadReviewScreenshot(input: { plan_id: string; file_name: string; content_type: string; bytes: Buffer; created_by: string }): Promise<{ id: string; width: number; height: number; sha256: string }> {
    if (input.content_type !== 'image/png' && input.content_type !== 'image/jpeg') throw new BillingProductsError('INVALID', 'the screenshot must be a PNG or JPEG');
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > 8 * 1024 * 1024) throw new BillingProductsError('INVALID', 'the screenshot must be at most 8 MB');
    const dims = imageDimensions(input.bytes, input.content_type);
    if (dims === null) throw new BillingProductsError('INVALID', 'the file is not a readable PNG or JPEG');
    const dimsError = reviewScreenshotDimensionsError(dims.width, dims.height);
    if (dimsError !== null) throw new BillingProductsError('INVALID', dimsError, { width: dims.width, height: dims.height });
    const plan = await this.prisma.plan.findUnique({ where: { id: input.plan_id }, select: { id: true } });
    if (plan === null) throw new BillingProductsError('NOT_FOUND', 'unknown plan');
    const id = uuidv7();
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const file_name = input.file_name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'screenshot';
    await this.prisma.billingAsset.create({
      data: { id, plan_id: input.plan_id, kind: 'APPLE_REVIEW_SCREENSHOT', file_name, content_type: input.content_type, bytes: new Uint8Array(input.bytes), sha256, width: dims.width, height: dims.height, created_by: input.created_by, created_at: this.clock() },
    });
    return { id, width: dims.width, height: dims.height, sha256 };
  }

  // ---- apply (BP-10) ---------------------------------------------------------------------------

  /** Inside the apply transaction: one PENDING job per billing product (BP-10; see billing-sync-enqueue.ts). */
  enqueue(tx: Tx, input: { change_request_id: string; plan_id: string; plan_version_id: string; payload: BillingProductsPayload; at: Date }): Promise<number> {
    return enqueueBillingProductSync(tx, input);
  }

  // ---- worker ------------------------------------------------------------------------------

  /** Drains due jobs (lease + SKIP LOCKED, safe with several workers). Returns how many it processed. */
  async drain(limit = 10): Promise<number> {
    const now = this.clock();
    const claimed = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "subscription"."BillingProductSync" SET "lease_until" = $1, "attempts" = "attempts" + 1, "updated_at" = $2
        WHERE "id" IN (SELECT "id" FROM "subscription"."BillingProductSync"
                        WHERE "status" IN ('PENDING', 'FAILED', 'NOT_CONFIGURED') AND "next_attempt_at" <= $2
                          AND ("lease_until" IS NULL OR "lease_until" < $2)
                        ORDER BY "next_attempt_at", "created_at" LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING "id"`,
      new Date(now.getTime() + LEASE_MS),
      now,
      limit,
    );
    for (const c of claimed) await this.process(c.id);
    return claimed.length;
  }

  private async process(id: string): Promise<void> {
    const job = await this.prisma.billingProductSync.findUniqueOrThrow({ where: { id } });
    const provider = job.provider as BillingProvider;
    const interval = job.interval as BillingInterval;
    const now = this.clock();
    const settle = (data: { status: BillingSyncStatus; next_attempt_at?: Date; last_error?: string | null; store_state?: string | null }) =>
      this.prisma.billingProductSync.update({
        where: { id },
        data: { status: data.status, next_attempt_at: data.next_attempt_at ?? now, last_error: data.last_error === undefined ? null : data.last_error?.slice(0, 1000) ?? null, ...(data.store_state !== undefined ? { store_state: data.store_state } : {}), lease_until: null, updated_at: this.clock() },
      });
    try {
      const current = await currentPublishedVersion(this.prisma, job.plan_id);
      if (current === null || current.id !== job.plan_version_id) {
        await settle({ status: 'NEEDS_ATTENTION', last_error: 'this version is no longer the published version; the newer version syncs the product' });
        return;
      }
      const port = this.ports.get(provider);
      if (port === undefined || !port.configured()) {
        await settle({ status: 'NOT_CONFIGURED', next_attempt_at: new Date(now.getTime() + NOT_CONFIGURED_RECHECK_MS), last_error: `${provider} sync is not configured` });
        return;
      }
      const request = await this.prisma.commercialChangeRequest.findUniqueOrThrow({ where: { id: job.change_request_id }, select: { payload: true } });
      const bp = ((request.payload as Record<string, unknown>)['billing_products'] ?? {}) as BillingProductsPayload;
      const target = await this.targetFor(job.plan_version_id, provider, interval, job.product_id, provider === 'APP_STORE' ? bp.apple_review_screenshot_asset_id ?? null : null, bp);
      const outcome = await port.sync(target);
      await this.prisma.$transaction(async (tx) => {
        const permanent = await tx.billingProduct.findUnique({ where: { plan_id_provider_interval: { plan_id: job.plan_id, provider, interval } } });
        if (permanent === null) {
          await tx.billingProduct.create({
            data: { id: uuidv7(), plan_id: job.plan_id, provider, interval, product_id: job.product_id, external_ref: outcome.external_ref, origin: outcome.origin === 'CREATED' ? 'CREATED' : 'ADOPTED', created_by: 'ccp-billing-sync', created_at: this.clock() },
          });
        } else if (permanent.product_id !== job.product_id) {
          throw new PlanVersionStateError(`${provider} ${interval} is permanently ${permanent.product_id}`);
        }
        if (provider === 'STRIPE') {
          await this.versions.pinProviderPrice({ plan_version_id: job.plan_version_id, provider: 'STRIPE', provider_price_ref: String(outcome.external_price_ref), created_by: 'ccp-billing-sync', at: this.clock() }, tx);
        } else {
          await this.versions.pinStoreProduct({ plan_version_id: job.plan_version_id, provider, product_id: job.product_id, interval, created_by: 'ccp-billing-sync', at: this.clock() }, tx);
        }
        await tx.billingProductSync.update({
          where: { id },
          data: { status: 'SYNCED', synced_at: this.clock(), store_state: outcome.store_state, external_price_ref: outcome.external_price_ref, last_error: outcome.detail?.slice(0, 1000) ?? null, lease_until: null, updated_at: this.clock() },
        });
      });
      this.log.log(`billing product synced: ${provider} ${job.product_id} (${outcome.origin}${outcome.store_state ? `, ${outcome.store_state}` : ''})`);
    } catch (e) {
      if (e instanceof BillingSyncError) {
        if (e.code === 'NOT_CONFIGURED') {
          await settle({ status: 'NOT_CONFIGURED', next_attempt_at: new Date(now.getTime() + NOT_CONFIGURED_RECHECK_MS), last_error: e.message });
        } else if (e.retryable && job.attempts <= BACKOFF_MS.length) {
          await settle({ status: 'FAILED', next_attempt_at: new Date(now.getTime() + BACKOFF_MS[Math.min(job.attempts, BACKOFF_MS.length) - 1]!), last_error: e.message });
        } else {
          await settle({ status: 'NEEDS_ATTENTION', last_error: e.message });
        }
      } else {
        await settle({ status: 'NEEDS_ATTENTION', last_error: e instanceof Error ? e.message : String(e) });
      }
      this.log.warn(`billing product sync ${provider} ${job.product_id}: ${e instanceof BillingSyncError ? e.code : 'ERROR'}`);
    }
  }

  // ---- console -----------------------------------------------------------------------------

  /** BP-14 — retry a job that did not sync (owner). A SYNCED job is final. */
  async retry(job_id: string): Promise<void> {
    const job = await this.prisma.billingProductSync.findUnique({ where: { id: job_id } });
    if (job === null) throw new BillingProductsError('NOT_FOUND', 'unknown sync job');
    if (job.status === 'SYNCED' || job.status === 'PENDING') throw new BillingProductsError('NOT_RETRYABLE', `a ${job.status} sync job is not retried`, { status: job.status });
    const now = this.clock();
    await this.prisma.billingProductSync.update({ where: { id: job_id }, data: { status: 'PENDING', next_attempt_at: now, lease_until: null, updated_at: now } });
  }

  /** The billing products of a plan version: permanent ids, the latest sync of each, and whether the channel sells it. */
  async status(plan_version_id: string): Promise<BillingProductView[]> {
    const version = await this.prisma.planVersion.findUnique({ where: { id: plan_version_id }, select: { plan_id: true } });
    if (version === null) throw new BillingProductsError('NOT_FOUND', 'unknown plan version');
    const [permanent, jobs, pins] = await Promise.all([
      this.prisma.billingProduct.findMany({ where: { plan_id: version.plan_id } }),
      this.prisma.billingProductSync.findMany({ where: { plan_version_id }, orderBy: { created_at: 'desc' } }),
      this.prisma.planVersionPrice.findMany({ where: { plan_version_id } }),
    ]);
    const slots = new Map<string, BillingProductView>();
    for (const p of permanent) slots.set(`${p.provider}:${p.interval}`, { provider: p.provider as BillingProvider, interval: p.interval as BillingInterval, product_id: p.product_id, origin: p.origin as 'CREATED' | 'ADOPTED', sync: null, linked: false });
    for (const j of jobs) {
      const k = `${j.provider}:${j.interval}`;
      const view = slots.get(k) ?? { provider: j.provider as BillingProvider, interval: j.interval as BillingInterval, product_id: j.product_id, origin: null, sync: null, linked: false };
      if (view.sync === null) {
        view.sync = { id: j.id, change_request_id: j.change_request_id, plan_version_id: j.plan_version_id, status: j.status as BillingSyncStatus, attempts: j.attempts, store_state: j.store_state, last_error: j.last_error, synced_at: j.synced_at?.toISOString() ?? null, next_attempt_at: j.next_attempt_at.toISOString() };
      }
      slots.set(k, view);
    }
    for (const pin of pins) {
      const k = `${pin.provider}:${pin.interval}`;
      const view = slots.get(k);
      if (view !== undefined) view.linked = true;
    }
    return [...slots.values()].sort((a, b) => `${a.provider}${a.interval}`.localeCompare(`${b.provider}${b.interval}`));
  }

  /** The billing products a new draft of the plan starts from (BP-11 carry-forward; ids per BP-3). */
  async carryForward(plan_id: string): Promise<{ products: BillingProductsPayload['products']; eligible: readonly BillingProvider[] }> {
    const plan = await this.prisma.plan.findUnique({ where: { id: plan_id }, select: { key: true, tenant_kind: true, sales_model: true } });
    if (plan === null) throw new BillingProductsError('NOT_FOUND', 'unknown plan');
    const sold = await this.soldChannels(plan_id);
    const permanent = await this.prisma.billingProduct.findMany({ where: { plan_id } });
    const products = sold.map((s) => {
      const p = permanent.find((x) => x.provider === s.provider && x.interval === s.interval);
      // A Stripe purchase link holds the PRICE id; the billing product is the Stripe product (BP-3 default).
      const fallback = s.provider === 'STRIPE' ? defaultProductId('STRIPE', plan.key, s.interval) : s.product_id;
      return { provider: s.provider, interval: s.interval, product_id: p?.product_id ?? fallback };
    });
    return { products, eligible: eligibleProviders(plan) };
  }

  /** BP-12 — catalog price vs each channel's live price, for every published version's linked products. */
  async mismatchReport(): Promise<MismatchEntry[]> {
    const out: MismatchEntry[] = [];
    const permanent = await this.prisma.billingProduct.findMany();
    for (const bp of permanent) {
      const port = this.ports.get(bp.provider as BillingProvider);
      const current = await currentPublishedVersion(this.prisma, bp.plan_id);
      if (current === null) continue;
      const target = await this.targetFor(current.id, bp.provider as BillingProvider, bp.interval as BillingInterval, bp.product_id, null).catch(() => null);
      if (target === null) continue;
      let live: LiveProviderPrice[] = [];
      if (port !== undefined && port.configured()) {
        try {
          live = await port.livePrices(target);
        } catch {
          live = [];
        }
      }
      const prices = bp.provider === 'STRIPE' ? target.prices.filter((p) => p.country === 'US') : target.prices;
      for (const p of prices) {
        const l = live.find((x) => x.country === p.country);
        const status: MismatchEntry['status'] = port === undefined || !port.configured() || l === undefined ? 'STORE_PRICE_UNAVAILABLE' : l.amount_minor === null ? 'MISSING_IN_STORE' : l.amount_minor === p.amount_minor && l.currency === p.currency ? 'MATCH' : 'MISMATCH';
        out.push({ plan_key: target.plan_key, plan_version_id: current.id, provider: bp.provider as BillingProvider, interval: bp.interval as BillingInterval, product_id: bp.product_id, country: p.country, currency: p.currency, catalog_amount_minor: p.amount_minor, live_amount_minor: l?.amount_minor ?? null, status });
      }
    }
    return out;
  }

  // ---- shared ------------------------------------------------------------------------------

  /** The sync target of a version + channel: name, description and the exact prices (BP-5) from the catalog. */
  async targetFor(
    plan_version_id: string,
    provider: BillingProvider,
    interval: BillingInterval,
    product_id: string,
    screenshot_asset_id: string | null,
    request: Pick<BillingProductsPayload, 'listing' | 'stop_countries'> = {},
  ): Promise<BillingSyncTarget> {
    const row = await this.prisma.planVersion.findUnique({ where: { id: plan_version_id } });
    if (row === null) throw new BillingSyncError('PROVIDER_REJECTED', `unknown plan version ${plan_version_id}`, false);
    const terms = planVersionTerms(row);
    const plan = terms.plan;
    const prices: BillingTargetPrice[] = [];
    if (plan.billing_interval === interval && plan.list_price_minor !== null && plan.currency !== null) {
      prices.push({ country: 'US', currency: plan.currency, amount_minor: plan.list_price_minor });
    }
    for (const r of terms.regional_prices ?? []) if (r.interval === interval) prices.push({ country: r.country, currency: r.currency, amount_minor: r.amount_minor });
    if (!prices.some((p) => p.country === 'US')) throw new BillingSyncError('PROVIDER_REJECTED', `the catalog has no US ${interval} list price for ${plan.key}`, false);
    const permanent = await this.prisma.billingProduct.findUnique({ where: { plan_id_provider_interval: { plan_id: row.plan_id, provider, interval } } });
    let review_screenshot: BillingSyncTarget['review_screenshot'] = null;
    if (screenshot_asset_id !== null) {
      const a = await this.prisma.billingAsset.findUnique({ where: { id: screenshot_asset_id } });
      if (a !== null) review_screenshot = { file_name: a.file_name, content_type: a.content_type, bytes: new Uint8Array(a.bytes), sha256: a.sha256 };
    }
    return {
      provider,
      interval,
      product_id,
      plan_id: row.plan_id,
      plan_key: plan.key,
      // A1-1 — the store listing of the request; the internal plan description never reaches a store.
      display_name: request.listing?.name.trim() ?? plan.name,
      description: request.listing?.description.trim() ?? (provider === 'STRIPE' ? plan.description ?? '' : ''),
      stop_countries: request.stop_countries ?? [],
      plan_version_id: row.id,
      version_number: row.version_number,
      prices,
      known_external_ref: permanent?.external_ref ?? null,
      review_screenshot,
    };
  }

  /** The channels the plan's current PUBLISHED version sells on (its purchase links). */
  private async soldChannels(plan_id: string): Promise<{ provider: BillingProvider; interval: BillingInterval; product_id: string }[]> {
    const current = await currentPublishedVersion(this.prisma, plan_id);
    if (current === null) return [];
    const pins = await this.prisma.planVersionPrice.findMany({ where: { plan_version_id: current.id } });
    return pins.map((p) => ({ provider: p.provider as BillingProvider, interval: p.interval as BillingInterval, product_id: p.provider_price_ref }));
  }
}

function asLink(r: { provider: string; interval: string; product_id: string }) {
  return { provider: r.provider as BillingProvider, interval: r.interval as BillingInterval, product_id: r.product_id };
}

export const BILLING_SYNC_TIMING = { BACKOFF_MS, NOT_CONFIGURED_RECHECK_MS, LEASE_MS };
