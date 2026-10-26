import { PRODUCT_CAPABILITIES, type ProductKey } from '../product-registry.js';

// CCP-R3 item 3 (Architect program acceptance disposition 2026-10-25, row TD-A7-5: deferred
// governed revocation; "effective access still fails closed once grace or overlay authority ends,
// and reconciliation and revocation must never leave indefinite active access").
//
// The ONE rule both readers use, so they agree by construction:
//   - the CCP-C6 reconciliation report's `entitled_without_subscription` list (every gap, with its
//     residual authority), and
//   - the CCP-D3 alert ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION (the gaps whose residual authority
//     is null: past grace, no live overlay).
// A gap = a tenant holds a live (unrevoked) product-specific capability of a product ('core' is
// shared, never product-specific) with NO open BASE subscription of that product. Residual
// authority = the latest grace_until of an ended BASE row of that tenant × product, or the latest
// unremoved support-extension overlay's extends_until, still after `at` (half-open).
//
// Neither reader revokes anything (no automatic revoke, TD-A7-5): allowance and capacity already
// refuse without an open sending row (they never read the entitlement). Pure: no I/O, no clock.

export type ResidualAuthorityKind = 'GRACE' | 'SUPPORT_OVERLAY';

export interface EntitlementGapInput {
  /** Live (revoked_at IS NULL) entitlement rows. */
  readonly entitlements: ReadonlyArray<{ readonly tenant_id: string; readonly capability: string }>;
  /** Open (ended_at IS NULL) BASE subscription rows, any status. */
  readonly open_base: ReadonlyArray<{ readonly tenant_id: string; readonly product_key: string }>;
  /** Possible residual authority: ended BASE rows' grace_until and unremoved overlays' extends_until. */
  readonly residual: ReadonlyArray<{ readonly tenant_id: string; readonly product_key: string; readonly kind: ResidualAuthorityKind; readonly until: Date }>;
  readonly products: readonly ProductKey[];
  readonly at: Date;
}

export interface EntitlementGap {
  readonly tenant_id: string;
  readonly product_key: ProductKey;
  readonly capabilities: string[];
  /** null → no grace and no live overlay remain: the D3 alert condition. */
  readonly residual_authority: ResidualAuthorityKind | null;
  readonly residual_authority_until: Date | null;
}

export function entitlementGaps(input: EntitlementGapInput): EntitlementGap[] {
  const capsOf = new Map<string, Set<string>>();
  for (const e of input.entitlements) {
    const s = capsOf.get(e.tenant_id) ?? new Set<string>();
    s.add(e.capability);
    capsOf.set(e.tenant_id, s);
  }
  const open = new Set(input.open_base.map((r) => `${r.tenant_id}\u0000${r.product_key}`));
  const out: EntitlementGap[] = [];
  for (const [tenant_id, caps] of capsOf) {
    for (const product_key of input.products) {
      const specific = PRODUCT_CAPABILITIES[product_key].filter((c) => c !== 'core' && caps.has(c));
      if (specific.length === 0) continue;
      if (open.has(`${tenant_id}\u0000${product_key}`)) continue;
      let best: { kind: ResidualAuthorityKind; until: Date } | null = null;
      for (const r of input.residual) {
        if (r.tenant_id !== tenant_id || r.product_key !== product_key || r.until.getTime() <= input.at.getTime()) continue;
        if (best === null || r.until.getTime() > best.until.getTime()) best = { kind: r.kind, until: r.until };
      }
      out.push({ tenant_id, product_key, capabilities: [...specific].sort(), residual_authority: best?.kind ?? null, residual_authority_until: best?.until ?? null });
    }
  }
  return out.sort((a, b) => (a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : a.product_key < b.product_key ? -1 : a.product_key > b.product_key ? 1 : 0));
}

/** The D3 alert subject for a gap: one alert per tenant × product. */
export const entitlementGapSubject = (g: { tenant_id: string; product_key: string }): string => `${g.tenant_id}:${g.product_key}`;

/** The residual-authority rows, as SQL over one snapshot (both readers run the same text). */
export const RESIDUAL_AUTHORITY_SQL = `SELECT ts.tenant_id::text AS tenant_id, ts.product_key, 'GRACE' AS kind, ts.grace_until AS until
     FROM subscription."TenantSubscription" ts
    WHERE ts.ended_at IS NOT NULL AND ts.composition_role = 'BASE' AND ts.grace_until > $1::timestamptz
   UNION ALL
   SELECT se.tenant_id::text AS tenant_id, se.product_key, 'SUPPORT_OVERLAY' AS kind, se.extends_until AS until
     FROM subscription."SupportExtension" se
    WHERE se.removed_at IS NULL AND se.extends_until > $1::timestamptz`;
