// CCP-A4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A4, §7.1 ruling A0-C7;
// MP-A2 N-6, N-10, N-11) — the governed, closed product registry and the explicit product
// context every subscription read and write carries.
//
//   PRODUCT_KEYS        the code mirror of the DB registry CHECKs
//                       (Plan_product_key_registry_check, TenantSubscription_product_key_registry_check,
//                       migration 20261025140000). v1 = sign only. A test pins the two together.
//                       Widening is an additive governed migration plus an approved catalog for
//                       the product; admitting a value never creates a plan (no invented plans).
//   ProductKey          a closed literal type: every operation that resolves or mutates a
//                       subscription takes it as a REQUIRED argument (no defaulting overload),
//                       so a call that omits it, or passes an allowance key in its place, does
//                       not compile.
//   BASE_COMPOSITION    MP-A2 N-10 shape (a): the only v1 composition_role.
//   metered keys        each allowance / capacity key maps to exactly one product through ONE
//                       declared namespace map (sign.* → sign). A call whose key does not map
//                       to the given product, or whose namespace is unmapped, throws (fail closed).

export const PRODUCT_KEYS = ['sign'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

/** Aramo Sign — the only registered product in v1. */
export const SIGN_PRODUCT_KEY: ProductKey = 'sign';

/** MP-A2 N-10 (a) — the v1 composition role (CHECK admits BASE only). */
export const BASE_COMPOSITION = 'BASE' as const;
export type CompositionRole = typeof BASE_COMPOSITION;

/** The single declared metered-key namespace → product mapping (MP-A2 N-11). */
const METERED_KEY_NAMESPACE: Readonly<Record<string, ProductKey>> = { sign: 'sign' };

export class ProductContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductContextError';
  }
}

export function isProductKey(value: unknown): value is ProductKey {
  return typeof value === 'string' && (PRODUCT_KEYS as readonly string[]).includes(value);
}

/** Runtime guard: an unregistered product is refused (fail closed). */
export function assertProductKey(value: unknown): ProductKey {
  if (!isProductKey(value)) throw new ProductContextError(`product ${String(value)} is not in the product registry`);
  return value;
}

/** The product an allowance or capacity key belongs to (sign.envelopes → sign). */
export function productOfMeteredKey(key: string): ProductKey {
  const ns = key.split('.', 1)[0] ?? '';
  const product = Object.prototype.hasOwnProperty.call(METERED_KEY_NAMESPACE, ns) ? METERED_KEY_NAMESPACE[ns] : undefined;
  if (product === undefined || !key.startsWith(`${ns}.`) || key.length === ns.length + 1) {
    throw new ProductContextError(`metered key ${key} maps to no registered product`);
  }
  return product;
}

/** A metered read or write for `product_key` may only use that product's keys. */
export function assertMeteredKeyOf(product_key: ProductKey, key: string): void {
  assertProductKey(product_key);
  const owner = productOfMeteredKey(key);
  if (owner !== product_key) throw new ProductContextError(`metered key ${key} belongs to product ${owner}, not ${product_key}`);
}

/**
 * The Prisma filter for a tenant's OPEN BASE subscription of one product (MP-A2 N-9, N-11).
 * Every open-row selector in libs/subscription goes through this.
 */
export function openBaseSubscription(tenant_id: string, product_key: ProductKey): {
  tenant_id: string;
  product_key: ProductKey;
  composition_role: CompositionRole;
  ended_at: null;
} {
  return { tenant_id, product_key: assertProductKey(product_key), composition_role: BASE_COMPOSITION, ended_at: null };
}

/**
 * CCP-A6 (Conversion Rule C-21) — the entitlement capabilities a governed subscription of each
 * registered product carries, granted in the same transaction as the subscription write. Sign:
 * the Business Sign capability bundle (`apps/platform-admin/src/app/signup/sign-signup.service.ts:59`
 * SIGN_CAPABILITIES = ['core', 'sign']). An ENTITLEMENT_GRANT for a product may grant only a
 * subset of this bundle.
 */
export const PRODUCT_CAPABILITIES: Readonly<Record<ProductKey, readonly string[]>> = { sign: ['core', 'sign'] };
