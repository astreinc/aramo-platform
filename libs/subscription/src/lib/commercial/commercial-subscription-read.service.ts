import { Injectable } from '@nestjs/common';

import { billingPeriodAt, type BillingPeriod } from '../billing-period.js';
import { assertProductKey, isProductKey, type ProductKey } from '../product-registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { taxAvailability, type TaxAvailability } from '../billing/tax-availability.js';

import { COMMERCIAL_OPEN_STATES } from './commercial-change-request.js';

// CCP-B3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B3; pre-execution record C-1;
// PLATFORM-UX-1 Amendment A1-4a; Conversion Rule C-8) — the READ-ONLY commercial reads behind the
// Subscriptions workbench and the tenant Commercial tab.
//
//   listWorkbench   the latest BASE subscription per tenant × product: the open row when one
//                   exists, else the most recently ended row.
//   tenantOverview  per product (sign, ats, portal, intelligence): the entitlement with its grant /
//                   revoke provenance, the latest BASE row, the OPEN reconciliation flags (held
//                   activations surfaced to operators, C-8) with their linked conversion request,
//                   and the tenant × product's open (Q14) change request.
//
// No money: no price, amount or currency is read or returned (A1-4a). Nothing here writes or calls
// the billing provider; the provider subscription ref is reduced to `provider_linked`. Each call
// runs in ONE REPEATABLE READ transaction opened READ ONLY (a consistent snapshot; a write raises).

/** The product order of the tenant overview (every Capability that names a product). */
export const OVERVIEW_PRODUCT_KEYS = ['sign', 'ats', 'portal', 'intelligence'] as const;
export type OverviewProductKey = (typeof OVERVIEW_PRODUCT_KEYS)[number];

/** A flag with no checkout intent carries no plan; it is attributed to the only v1 product. */
const UNATTRIBUTED_FLAG_PRODUCT: ProductKey = 'sign';

export interface WorkbenchSubscription {
  readonly subscription_id: string;
  readonly product_key: string;
  readonly plan: { readonly id: string; readonly key: string; readonly name: string; readonly sales_model: string };
  readonly plan_version: { readonly id: string; readonly version_number: number; readonly status: string };
  readonly source: string;
  readonly status: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly period_anchor: Date;
  /** The billing period containing as_of; null for an ended row. */
  readonly current_period: BillingPeriod | null;
  readonly current_period_end: Date | null;
  readonly grace_until: Date | null;
  readonly commitment_end: Date | null;
  readonly contract: { readonly id: string; readonly contract_ref: string } | null;
  /** A provider subscription is linked (the ref itself is not exposed here). */
  readonly provider_linked: boolean;
  /** Reasons of the OPEN reconciliation flags of the tenant attributed to this product (sorted, distinct). */
  readonly open_flags: string[];
  readonly active_extensions: { readonly count: number; readonly exception: boolean };
}

export interface WorkbenchRow extends WorkbenchSubscription {
  readonly tenant: { readonly id: string; readonly name: string | null; readonly slug: string | null };
}

export interface WorkbenchResult {
  readonly as_of: Date;
  readonly rows: WorkbenchRow[];
}

export type EntitlementState = 'ACTIVE' | 'REVOKED' | 'NONE';

export interface ProductEntitlement {
  readonly capability: string;
  readonly state: EntitlementState;
  readonly granted_source: string | null;
  readonly granted_at: Date | null;
  readonly granted_by: string | null;
  readonly change_request_id: string | null;
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
  readonly revoke_change_request_id: string | null;
}

export interface OverviewFlag {
  readonly id: string;
  readonly reason: string;
  readonly provider: string;
  readonly subscription_ref: string;
  readonly intent_id: string | null;
  readonly detected_at: Date;
  readonly conversion: { readonly change_request_id: string; readonly state: string; readonly direction: string | null } | null;
}

export interface OverviewOpenRequest {
  readonly id: string;
  readonly action_type: string;
  readonly kind: string;
  readonly state: string;
  readonly requested_by: string;
  readonly created_at: Date;
}

export interface OverviewProduct {
  readonly product_key: OverviewProductKey;
  /** In the product registry (PRODUCT_KEYS, product-registry.ts; v1 = sign only). */
  readonly registered: boolean;
  readonly entitlement: ProductEntitlement;
  readonly subscription: WorkbenchSubscription | null;
  readonly flags: OverviewFlag[];
  readonly open_request: OverviewOpenRequest | null;
}

export interface TenantCommercialOverview {
  readonly as_of: Date;
  readonly tenant: { readonly id: string; readonly name: string; readonly slug: string | null; readonly kind: string };
  readonly products: OverviewProduct[];
  /** CCP-C5 — tax is a designed disabled state until Stripe Tax registration (PBD §10). */
  readonly tax: TaxAvailability;
}

type Tx = Pick<PrismaService, '$queryRawUnsafe' | '$executeRawUnsafe'>;

interface LatestRow {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_slug: string | null;
  product_key: string;
  plan_id: string;
  plan_key: string;
  plan_name: string;
  sales_model: string;
  plan_version_id: string;
  version_number: number;
  version_status: string;
  source: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  period_anchor: Date;
  current_period_end: Date | null;
  grace_until: Date | null;
  commitment_end: Date | null;
  contract_id: string | null;
  contract_ref: string | null;
  provider_linked: boolean;
  extension_count: number;
  extension_exception: boolean;
}

interface FlagRow {
  id: string;
  tenant_id: string;
  reason: string;
  provider: string;
  subscription_ref: string;
  intent_id: string | null;
  detected_at: Date;
  intent_product_key: string | null;
}

/**
 * The latest BASE row per tenant × product (open first, else the latest ended_at), with its
 * contract and the count of its active support extensions at $1 (as_of). `where` filters `ts`.
 */
const LATEST_SQL = (where: string) => `
  SELECT ts.id::text AS subscription_id, ts.tenant_id::text AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
         ts.product_key, p.id::text AS plan_id, p.key AS plan_key, p.name AS plan_name, p.sales_model,
         v.id::text AS plan_version_id, v.version_number, v.status AS version_status,
         ts.source, ts.status, ts.started_at, ts.ended_at, ts.period_anchor,
         ts.current_period_end, ts.grace_until, ts.commitment_end,
         c.id::text AS contract_id, c.contract_ref,
         (ts.billing_subscription_ref IS NOT NULL) AS provider_linked,
         (SELECT count(*)::int FROM subscription."SupportExtension" se
           WHERE se.subscription_id = ts.id AND se.removed_at IS NULL AND se.extends_until > $1::timestamptz) AS extension_count,
         COALESCE((SELECT bool_or(se.is_exception) FROM subscription."SupportExtension" se
           WHERE se.subscription_id = ts.id AND se.removed_at IS NULL AND se.extends_until > $1::timestamptz), false) AS extension_exception
    FROM (
      SELECT DISTINCT ON (s.tenant_id, s.product_key) s.*
        FROM subscription."TenantSubscription" s
       WHERE s.composition_role = 'BASE'${where}
       ORDER BY s.tenant_id, s.product_key, (s.ended_at IS NULL) DESC, s.ended_at DESC NULLS LAST, s.id DESC
    ) ts
    JOIN subscription."Plan" p ON p.id = ts.plan_id
    JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
    LEFT JOIN identity."Tenant" t ON t.id = ts.tenant_id
    LEFT JOIN subscription."Contract" c ON c.tenant_subscription_id = ts.id
   ORDER BY t.name ASC NULLS LAST, ts.product_key, ts.id`;

const FLAGS_SQL = (where: string) => `
  SELECT f.id::text AS id, f.tenant_id::text AS tenant_id, f.reason, f.provider, f.subscription_ref,
         f.intent_id::text AS intent_id, f.detected_at, p.product_key AS intent_product_key
    FROM subscription."BillingReconciliationFlag" f
    LEFT JOIN subscription."CheckoutIntent" ci ON ci.id = f.intent_id
    LEFT JOIN subscription."Plan" p ON p.id = ci.plan_id
   WHERE f.resolved_at IS NULL${where}
   ORDER BY f.detected_at, f.id`;

/** The product an open flag is attributed to (its intent's plan; no intent → sign). */
function flagProduct(f: FlagRow): string {
  return f.intent_id === null ? UNATTRIBUTED_FLAG_PRODUCT : (f.intent_product_key ?? UNATTRIBUTED_FLAG_PRODUCT);
}

function toSubscription(r: LatestRow, as_of: Date, open_flags: string[]): WorkbenchSubscription {
  return {
    subscription_id: r.subscription_id,
    product_key: r.product_key,
    plan: { id: r.plan_id, key: r.plan_key, name: r.plan_name, sales_model: r.sales_model },
    plan_version: { id: r.plan_version_id, version_number: r.version_number, status: r.version_status },
    source: r.source,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    period_anchor: r.period_anchor,
    current_period: r.ended_at === null ? billingPeriodAt(r.period_anchor, as_of) : null,
    current_period_end: r.current_period_end,
    grace_until: r.grace_until,
    commitment_end: r.commitment_end,
    contract: r.contract_id === null || r.contract_ref === null ? null : { id: r.contract_id, contract_ref: r.contract_ref },
    provider_linked: r.provider_linked,
    open_flags,
    active_extensions: { count: r.extension_count, exception: r.extension_exception },
  };
}

function reasonsOf(flags: readonly FlagRow[], tenant_id: string, product_key: string): string[] {
  return [...new Set(flags.filter((f) => f.tenant_id === tenant_id && flagProduct(f) === product_key).map((f) => f.reason))].sort();
}

@Injectable()
export class CommercialSubscriptionReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** One consistent, provably read-only snapshot. */
  private async readOnly<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /** The Subscriptions workbench: the latest BASE row per tenant × product. */
  async listWorkbench(opts: { product_key?: ProductKey; as_of?: Date } = {}): Promise<WorkbenchResult> {
    const as_of = opts.as_of ?? new Date();
    const params: unknown[] = [as_of];
    let where = '';
    if (opts.product_key !== undefined) {
      params.push(assertProductKey(opts.product_key));
      where = ` AND s.product_key = $${params.length}`;
    }
    const data = await this.readOnly(async (tx) => {
      const rows = await tx.$queryRawUnsafe<LatestRow[]>(LATEST_SQL(where), ...params);
      const flags = await tx.$queryRawUnsafe<FlagRow[]>(FLAGS_SQL(''));
      return { rows, flags };
    });
    return {
      as_of,
      rows: data.rows.map((r) => ({
        ...toSubscription(r, as_of, reasonsOf(data.flags, r.tenant_id, r.product_key)),
        tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
      })),
    };
  }

  /** The tenant Commercial tab; null when the tenant does not exist. */
  async tenantOverview(tenant_id: string, opts: { as_of?: Date } = {}): Promise<TenantCommercialOverview | null> {
    const as_of = opts.as_of ?? new Date();
    const data = await this.readOnly(async (tx) => {
      const tenants = await tx.$queryRawUnsafe<Array<{ id: string; name: string; slug: string | null; kind: string }>>(
        `SELECT id::text AS id, name, slug, kind FROM identity."Tenant" WHERE id = $1::uuid`,
        tenant_id,
      );
      const tenant = tenants[0];
      if (tenant === undefined) return null;
      const rows = await tx.$queryRawUnsafe<LatestRow[]>(LATEST_SQL(` AND s.tenant_id = $2::uuid`), as_of, tenant_id);
      const flags = await tx.$queryRawUnsafe<FlagRow[]>(FLAGS_SQL(` AND f.tenant_id = $1::uuid`), tenant_id);
      const entitlements = await tx.$queryRawUnsafe<
        Array<{
          capability: string;
          granted_source: string | null;
          granted_at: Date | null;
          granted_by: string | null;
          change_request_id: string | null;
          revoked_at: Date | null;
          revoked_by: string | null;
          revoke_change_request_id: string | null;
        }>
      >(
        `SELECT capability::text AS capability, granted_source, granted_at, granted_by::text AS granted_by,
                change_request_id::text AS change_request_id, revoked_at, revoked_by::text AS revoked_by,
                revoke_change_request_id::text AS revoke_change_request_id
           FROM entitlement."TenantEntitlement" WHERE tenant_id = $1::uuid`,
        tenant_id,
      );
      const conversions = await tx.$queryRawUnsafe<Array<{ id: string; state: string; direction: string | null; held_subscription_ref: string; created_at: Date }>>(
        `SELECT id::text AS id, state, payload->>'direction' AS direction, payload->>'held_subscription_ref' AS held_subscription_ref, created_at
           FROM subscription."CommercialChangeRequest"
          WHERE tenant_id = $1::uuid AND action_type = 'CONVERSION' AND payload->>'held_subscription_ref' IS NOT NULL
          ORDER BY created_at DESC, id DESC`,
        tenant_id,
      );
      const openRequests = await tx.$queryRawUnsafe<Array<OverviewOpenRequest & { product_key: string | null }>>(
        `SELECT id::text AS id, action_type, kind, state, requested_by::text AS requested_by, created_at, product_key
           FROM subscription."CommercialChangeRequest"
          WHERE tenant_id = $1::uuid AND state = ANY($2::text[])
          ORDER BY created_at DESC, id DESC`,
        tenant_id,
        [...COMMERCIAL_OPEN_STATES],
      );
      return { tenant, rows, flags, entitlements, conversions, openRequests };
    });
    if (data === null) return null;

    const products: OverviewProduct[] = OVERVIEW_PRODUCT_KEYS.map((product_key) => {
      const e = data.entitlements.find((x) => x.capability === product_key);
      const entitlement: ProductEntitlement = {
        capability: product_key,
        state: e === undefined ? 'NONE' : e.revoked_at === null ? 'ACTIVE' : 'REVOKED',
        granted_source: e?.granted_source ?? null,
        granted_at: e?.granted_at ?? null,
        granted_by: e?.granted_by ?? null,
        change_request_id: e?.change_request_id ?? null,
        revoked_at: e?.revoked_at ?? null,
        revoked_by: e?.revoked_by ?? null,
        revoke_change_request_id: e?.revoke_change_request_id ?? null,
      };
      const row = data.rows.find((r) => r.product_key === product_key);
      const flags: OverviewFlag[] = data.flags
        .filter((f) => flagProduct(f) === product_key)
        .map((f) => {
          const c = data.conversions.find((x) => x.held_subscription_ref === f.subscription_ref);
          return {
            id: f.id,
            reason: f.reason,
            provider: f.provider,
            subscription_ref: f.subscription_ref,
            intent_id: f.intent_id,
            detected_at: f.detected_at,
            conversion: c === undefined ? null : { change_request_id: c.id, state: c.state, direction: c.direction },
          };
        });
      const open = data.openRequests.find((x) => x.product_key === product_key);
      return {
        product_key,
        registered: isProductKey(product_key),
        entitlement,
        subscription: row === undefined ? null : toSubscription(row, as_of, reasonsOf(data.flags, tenant_id, product_key)),
        flags,
        open_request:
          open === undefined
            ? null
            : { id: open.id, action_type: open.action_type, kind: open.kind, state: open.state, requested_by: open.requested_by, created_at: open.created_at },
      };
    });
    return { as_of, tenant: data.tenant, products, tax: taxAvailability() };
  }
}
