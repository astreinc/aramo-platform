// CCP-B2 — the Catalog fixtures: the CCP prototype's P0 plans and the T0 pins (ccp-data.js,
// CCP-UI v1.0) ported into the REAL catalog DTOs (GET /platform/commercial/catalog and
// GET /platform/commercial/catalog/versions/:id). TEST-ONLY; nothing here ships.
//
// The prototype's sample data shows TWO PUBLISHED versions of Starter and of Team at once. The
// A5 store admits one PUBLISHED version per plan (PlanVersion_one_published_per_plan; publishing
// retires the previous one), so the real API never returns that state; the fixture reproduces
// the prototype verbatim only so the renderer can be compared pixel for pixel
// (DIVERGENCES.md DV-B2-05). The renderer is data-driven: the real states render through the
// same code, and the unit specs cover them.

import type { Handler } from './mock-api';

const json = (body: unknown, status = 200) => ({ status, body });
const GIB = 1024 ** 3;

type St = 'PUBLISHED' | 'DRAFT' | 'RETIRED';
interface Seed {
  v: number;
  status: St;
  price: number | null;
  env: number;
  gb: number;
  pub?: string;
  ret?: string;
  pinned: string[];
  cr?: string;
}

/** ccp-data.js P0, with T0's subscriptions as the pinned tenants (pinCount counts every T0 sub). */
const P0: { id: string; name: string; contractOnly?: boolean; vers: Seed[] }[] = [
  { id: 'starter', name: 'Starter', vers: [{ v: 1, status: 'PUBLISHED', price: 19, env: 100, gb: 5, pub: '2026-01-15', pinned: ['Fernhill Studio'] }, { v: 2, status: 'PUBLISHED', price: 24, env: 150, gb: 10, pub: '2026-07-01', pinned: ['Oakridge Dental'] }] },
  {
    id: 'team',
    name: 'Team',
    vers: [
      { v: 1, status: 'PUBLISHED', price: 49, env: 500, gb: 25, pub: '2026-01-15', pinned: ['Quarry Lane Legal'] },
      { v: 2, status: 'PUBLISHED', price: 59, env: 750, gb: 50, pub: '2026-07-01', pinned: ['Northwind Logistics'] },
      { v: 3, status: 'DRAFT', price: 69, env: 1000, gb: 50, pinned: [], cr: 'cca10000-0000-7000-8000-000000001044' },
    ],
  },
  { id: 'business', name: 'Business', vers: [{ v: 1, status: 'RETIRED', price: 129, env: 3000, gb: 200, pub: '2025-02-01', ret: '2026-07-01', pinned: ['Brightline Retail'] }, { v: 2, status: 'PUBLISHED', price: 139, env: 3000, gb: 200, pub: '2026-07-01', pinned: ['Atlas Freight'] }] },
  { id: 'scale', name: 'Scale', vers: [{ v: 1, status: 'PUBLISHED', price: 299, env: 10000, gb: 1000, pub: '2025-02-01', pinned: ['Meridian Partners'] }] },
  { id: 'enterprise', name: 'Enterprise', contractOnly: true, vers: [{ v: 1, status: 'PUBLISHED', price: null, env: 25000, gb: 5000, pub: '2025-02-01', pinned: ['Halcyon Health'] }] },
];

const vid = (plan: string, v: number) => `${plan}-v${String(v)}`;
const day = (d: string | undefined) => (d === undefined ? null : `${d}T00:00:00.000Z`);

export interface CatalogFixtureOptions {
  /** Drop Team v3's open publish request (the publish-dialog state). */
  readonly noOpenRequest?: boolean;
}

function version(plan: (typeof P0)[number], s: Seed, o: CatalogFixtureOptions) {
  return {
    id: vid(plan.id, s.v),
    plan_id: plan.id,
    version_number: s.v,
    status: s.status,
    content_checksum: 'c'.repeat(64),
    note: null,
    created_by: 'lena',
    created_at: day(s.pub) ?? '2026-10-24T11:00:00.000Z',
    published_at: s.status === 'DRAFT' ? null : day(s.pub),
    retired_at: day(s.ret),
    terms: {
      list_price_minor: s.price === null ? null : s.price * 100,
      currency: s.price === null ? null : 'USD',
      billing_interval: s.price === null ? null : 'MONTH',
      sales_model: plan.contractOnly ? 'CONTACT_SALES' : 'SELF_SERVICE',
      contract_priced: plan.contractOnly === true,
      envelopes_per_month: s.env,
      envelopes_unlimited: false,
      envelopes_present: true,
      storage_bytes: s.gb * GIB,
      storage_unlimited: false,
      storage_present: true,
    },
    pinned_subscriptions: s.pinned.length,
    open_requests: s.cr && !o.noOpenRequest ? [{ id: s.cr, action_type: 'PLAN_VERSION_PUBLISH', state: 'PENDING_APPROVAL', expires_at: '2026-10-27T11:00:00.000Z' }] : [],
  };
}

function plans(o: CatalogFixtureOptions) {
  return P0.map((p, i) => ({
    id: p.id,
    key: `aramo-sign-${p.id}-v1`,
    product_key: 'sign',
    name: p.name,
    status: 'ACTIVE',
    sales_model: p.contractOnly ? 'CONTACT_SALES' : 'SELF_SERVICE',
    sellable: !p.contractOnly,
    display_order: (i + 1) * 10,
    versions: [...p.vers].reverse().map((s) => version(p, s, o)),
  }));
}

export function catalogHandlers(o: CatalogFixtureOptions = {}): [string, RegExp, Handler][] {
  return [
    [
      'GET',
      /^\/platform\/commercial\/catalog$/,
      () => json({ products: [{ product_key: 'sign', plans: plans(o) }], publish_chain: { rule: 'FINANCE_THEN_OWNER', step_role_keys: ['finance_admin', 'platform_owner'], policy_version_id: 'pol-1', policy_version_number: 1, approval_expiry_hours: 72 } }),
    ],
    [
      'GET',
      /^\/platform\/commercial\/catalog\/versions\/[^/]+$/,
      ({ path }) => {
        const id = decodeURIComponent(path.split('/').at(-1) ?? '');
        for (const p of plans(o)) {
          const v = p.versions.find((x) => x.id === id);
          if (v) {
            const seed = P0.find((x) => x.id === p.id)?.vers.find((x) => x.v === v.version_number);
            const plan = { id: p.id, key: p.key, product_key: p.product_key, name: p.name, status: p.status, sales_model: p.sales_model, sellable: p.sellable, display_order: p.display_order };
            return json({ version: v, plan, content: {}, pinned_tenants: (seed?.pinned ?? []).map((name, i) => ({ tenant_id: `t-${String(i)}`, name })) });
          }
        }
        return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      },
    ],
  ];
}
