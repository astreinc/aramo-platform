import type { PrismaService } from '../prisma/prisma.service.js';
import { currentPublishedVersion } from '../plan-version.repository.js';
import type { ProductKey } from '../product-registry.js';

// CCP-A5 (MP-A2 N-17; Charter D3 "moved into PlanVersion data, with an env-parity check during
// cutover") — the provider price is pinned to the plan version (subscription."PlanVersionPrice")
// and replaces STRIPE_PLAN_PRICES as the authority. During cutover the env stays a FALLBACK:
//
//   current version pinned, env absent or equal   → the pin (authority)
//   current version pinned, env differs            → no price: checkout fails closed (parity mismatch)
//   current version not pinned, env has the key    → the env value (cutover fallback)
//   neither                                        → no price (as before A5)
//
// A provider price seen on a webhook resolves to a VERSION (planForPrice): a pin first (any
// non-DRAFT version, so a grandfathered subscription on a RETIRED version still resolves), else
// the env fallback onto the plan's current PUBLISHED version when that version is unpinned.
// checkProviderPriceParity is the read-only cutover check (READ ONLY transaction).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Db = Tx | PrismaService;

export const BILLING_PRICE_PROVIDER = 'STRIPE' as const;
export type BillingPriceProvider = typeof BILLING_PRICE_PROVIDER;

/** STRIPE_PLAN_PRICES = "plan-key=price_x,other-key=price_y" (operator config; cutover fallback). */
export function parsePlanPrices(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k !== '' && v !== '') m.set(k, v);
  }
  return m;
}

export type EffectivePrice =
  | { readonly ok: true; readonly ref: string; readonly source: 'PIN' | 'ENV' }
  | { readonly ok: false; readonly reason: 'NO_PRICE' | 'PARITY_MISMATCH' };

/** The checkout price of a plan's CURRENT (PUBLISHED) version under the cutover rule. */
export async function effectiveProviderPrice(db: Db, version_id: string, plan_key: string, env: ReadonlyMap<string, string>): Promise<EffectivePrice> {
  const pin = await db.planVersionPrice.findUnique({ where: { plan_version_id_provider: { plan_version_id: version_id, provider: BILLING_PRICE_PROVIDER } } });
  const envRef = env.get(plan_key);
  if (pin !== null) {
    if (envRef !== undefined && envRef !== pin.provider_price_ref) return { ok: false, reason: 'PARITY_MISMATCH' };
    return { ok: true, ref: pin.provider_price_ref, source: 'PIN' };
  }
  if (envRef !== undefined) return { ok: true, ref: envRef, source: 'ENV' };
  return { ok: false, reason: 'NO_PRICE' };
}

export interface PriceResolution {
  readonly plan_id: string;
  readonly plan_version_id: string;
  readonly version_status: string;
  // M-A12 — STORE: resolved through a store product pin (stable across versions of one plan).
  readonly source: 'PIN' | 'ENV' | 'STORE';
}

// ---- M-A12 W1-G: store product pins ---------------------------------------------------------

export type StoreProvider = 'APP_STORE' | 'GOOGLE_PLAY';

/**
 * A store product → the version of its plan a purchase opens: the plan's PUBLISHED version when that
 * version pins the product, else the newest non-DRAFT version pinning it (a grandfathered product on a
 * RETIRED version). Null when the product is unpinned, or its plan is not a sellable plan of the product.
 */
export async function resolveStoreProductToVersion(db: Db, provider: StoreProvider, product_id: string, product_key: ProductKey): Promise<PriceResolution | null> {
  const pins = await db.planVersionPrice.findMany({
    where: { provider, provider_price_ref: product_id, plan_version: { status: { not: 'DRAFT' } } },
    include: { plan_version: { include: { plan: true } } },
  });
  if (pins.length === 0) return null;
  const ranked = [...pins].sort((a, b) =>
    a.plan_version.status === 'PUBLISHED' ? -1 : b.plan_version.status === 'PUBLISHED' ? 1 : b.plan_version.version_number - a.plan_version.version_number,
  );
  const v = (ranked[0] as (typeof pins)[number]).plan_version;
  if (!v.plan.sellable || v.plan.product_key !== product_key) return null;
  return { plan_id: v.plan_id, plan_version_id: v.id, version_status: v.status, source: 'STORE' };
}

/** The billed interval of a store product (from its pin), or null when the product is not pinned. */
export async function storePinInterval(db: Db, provider: StoreProvider, product_id: string | null): Promise<'MONTH' | 'YEAR' | null> {
  if (product_id === null) return null;
  const pin = await db.planVersionPrice.findFirst({ where: { provider, provider_price_ref: product_id }, select: { interval: true } });
  return pin?.interval === 'MONTH' || pin?.interval === 'YEAR' ? pin.interval : null;
}

/** The store products pinned to a version (for the plans view): platform, product id, interval. */
export async function storeProductsOfVersion(db: Db, plan_version_id: string): Promise<{ platform: 'ios' | 'android'; product_id: string; interval: 'MONTH' | 'YEAR' }[]> {
  const pins = await db.planVersionPrice.findMany({
    where: { plan_version_id, provider: { in: ['APP_STORE', 'GOOGLE_PLAY'] } },
    orderBy: [{ provider: 'asc' }, { interval: 'asc' }],
  });
  return pins.map((p) => ({ platform: p.provider === 'APP_STORE' ? ('ios' as const) : ('android' as const), product_id: p.provider_price_ref, interval: p.interval === 'YEAR' ? ('YEAR' as const) : ('MONTH' as const) }));
}

/** A provider price → a version of a sellable plan of the SAME product, else null (planForPrice). */
export async function resolvePriceToVersion(db: Db, price_ref: string, product_key: ProductKey, env: ReadonlyMap<string, string>): Promise<PriceResolution | null> {
  const pin = await db.planVersionPrice.findUnique({
    where: { provider_provider_price_ref: { provider: BILLING_PRICE_PROVIDER, provider_price_ref: price_ref } },
    include: { plan_version: { include: { plan: true } } },
  });
  if (pin !== null) {
    const v = pin.plan_version;
    // A pinned price is authoritative: it never falls through to the env mapping.
    if (v.status === 'DRAFT' || !v.plan.sellable || v.plan.product_key !== product_key) return null;
    return { plan_id: v.plan_id, plan_version_id: v.id, version_status: v.status, source: 'PIN' };
  }
  for (const [key, price] of env) {
    if (price !== price_ref) continue;
    const plan = await db.plan.findUnique({ where: { key } });
    if (plan === null || !plan.sellable || plan.product_key !== product_key) continue;
    const current = await currentPublishedVersion(db, plan.id);
    if (current === null) continue;
    const pinned = await db.planVersionPrice.findUnique({ where: { plan_version_id_provider: { plan_version_id: current.id, provider: BILLING_PRICE_PROVIDER } } });
    if (pinned !== null) continue;
    return { plan_id: plan.id, plan_version_id: current.id, version_status: current.status, source: 'ENV' };
  }
  return null;
}

// ---- the read-only cutover parity check ------------------------------------------------------

export type PriceParityStatus = 'MATCH' | 'ENV_FALLBACK' | 'PINNED_ONLY' | 'MISMATCH' | 'UNKNOWN_PLAN' | 'NO_PUBLISHED_VERSION' | 'DUPLICATE_PRICE';

export interface PriceParityEntry {
  readonly plan_key: string;
  readonly status: PriceParityStatus;
  readonly env_price_ref: string | null;
  readonly pinned_price_ref: string | null;
  readonly plan_version_id: string | null;
  readonly version_number: number | null;
  readonly detail?: string;
}

export interface PriceParityReport {
  readonly ok: boolean;
  readonly strict: boolean;
  readonly provider: BillingPriceProvider;
  readonly entries: readonly PriceParityEntry[];
  readonly failures: number;
}

const ALWAYS_FAILING: ReadonlySet<PriceParityStatus> = new Set(['MISMATCH', 'UNKNOWN_PLAN', 'NO_PUBLISHED_VERSION', 'DUPLICATE_PRICE']);

/**
 * Compare STRIPE_PLAN_PRICES with the version pins. Read-only by construction (READ ONLY
 * transaction). Non-strict (cutover): ENV_FALLBACK passes. Strict (after cutover): every env
 * entry must MATCH a pin. MISMATCH, UNKNOWN_PLAN, NO_PUBLISHED_VERSION and DUPLICATE_PRICE fail.
 */
export async function checkProviderPriceParity(prisma: PrismaService, raw: string | undefined, opts: { strict?: boolean } = {}): Promise<PriceParityReport> {
  const strict = opts.strict === true;
  const env = parsePlanPrices(raw);
  const entries = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const out: PriceParityEntry[] = [];
    const byPrice = new Map<string, string[]>();
    for (const [k, v] of env) byPrice.set(v, [...(byPrice.get(v) ?? []), k]);
    for (const [plan_key, envRef] of env) {
      const base = { plan_key, env_price_ref: envRef };
      if ((byPrice.get(envRef) ?? []).length > 1) {
        out.push({ ...base, status: 'DUPLICATE_PRICE', pinned_price_ref: null, plan_version_id: null, version_number: null, detail: `price shared by ${(byPrice.get(envRef) ?? []).join(', ')}` });
        continue;
      }
      const plan = await tx.plan.findUnique({ where: { key: plan_key } });
      if (plan === null) {
        out.push({ ...base, status: 'UNKNOWN_PLAN', pinned_price_ref: null, plan_version_id: null, version_number: null });
        continue;
      }
      const current = await currentPublishedVersion(tx, plan.id);
      if (current === null) {
        out.push({ ...base, status: 'NO_PUBLISHED_VERSION', pinned_price_ref: null, plan_version_id: null, version_number: null });
        continue;
      }
      const at = { plan_version_id: current.id, version_number: current.version_number };
      const pin = await tx.planVersionPrice.findUnique({ where: { plan_version_id_provider: { plan_version_id: current.id, provider: BILLING_PRICE_PROVIDER } } });
      if (pin !== null) {
        out.push({ ...base, ...at, pinned_price_ref: pin.provider_price_ref, status: pin.provider_price_ref === envRef ? 'MATCH' : 'MISMATCH' });
        continue;
      }
      // Unpinned: the env price must not already be pinned to some other version.
      const elsewhere = await tx.planVersionPrice.findUnique({
        where: { provider_provider_price_ref: { provider: BILLING_PRICE_PROVIDER, provider_price_ref: envRef } },
        include: { plan_version: { include: { plan: true } } },
      });
      if (elsewhere !== null) {
        out.push({ ...base, ...at, pinned_price_ref: null, status: 'MISMATCH', detail: `price is pinned to ${elsewhere.plan_version.plan.key} v${elsewhere.plan_version.version_number}` });
        continue;
      }
      out.push({ ...base, ...at, pinned_price_ref: null, status: 'ENV_FALLBACK' });
    }
    // Pinned current versions with no env entry: the pin alone is the authority.
    const pinnedCurrent = await tx.planVersionPrice.findMany({
      where: { provider: BILLING_PRICE_PROVIDER, plan_version: { status: 'PUBLISHED' } },
      include: { plan_version: { include: { plan: true } } },
    });
    for (const p of pinnedCurrent) {
      if (env.has(p.plan_version.plan.key)) continue;
      out.push({
        plan_key: p.plan_version.plan.key,
        status: 'PINNED_ONLY',
        env_price_ref: null,
        pinned_price_ref: p.provider_price_ref,
        plan_version_id: p.plan_version_id,
        version_number: p.plan_version.version_number,
      });
    }
    return out.sort((a, b) => (a.plan_key < b.plan_key ? -1 : a.plan_key > b.plan_key ? 1 : 0));
  });
  const failures = entries.filter((e) => ALWAYS_FAILING.has(e.status) || (strict && e.status === 'ENV_FALLBACK')).length;
  return { ok: failures === 0, strict, provider: BILLING_PRICE_PROVIDER, entries, failures };
}
