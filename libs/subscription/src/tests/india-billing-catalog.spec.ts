import { describe, expect, it } from 'vitest';

import { BillingRegionService } from '../lib/billing/region/billing-region.service.js';
import { BillingProductsService } from '../lib/billing/sync/billing-products.service.js';
import type { BillingSyncTarget } from '../lib/billing/sync/billing-sync.port.js';
import { BillingSyncError } from '../lib/billing/sync/billing-sync.port.js';
import { BillingNotSellableError, RazorpayCatalogWriter } from '../lib/billing/sync/razorpay-catalog.writer.js';
import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyService } from '../lib/commercial/commercial-apply.service.js';
import {
  BILLING_REGION_APPLY_FAILURE_CODES,
  CommercialBillingRegionApplyService,
  CommercialBillingRegionReadService,
} from '../lib/commercial/commercial-billing-region-apply.service.js';
import type { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import type { CommercialChangeRequestRow, CommercialChangeRequestService } from '../lib/commercial/commercial-change-request.service.js';
import type { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { planVersionChecksum, planVersionContentFromRows } from '../lib/plan-version.js';
import type { PlanVersionRepository } from '../lib/plan-version.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.6, §4.10, rulings Q3 and Q8 — the Razorpay
// catalog writer (against an in-memory Razorpay plan store; no network, no credential), the region-aware
// sync target, and the governed BILLING_REGION_CHANGE apply (against an in-memory store that rolls a
// failed transaction back, as Postgres does).

// ---- the Razorpay catalog writer ----------------------------------------------------------------

const VERSION = '019a0000-0000-7000-8000-000000000002';
const CREDS = { key_id: 'rzp_test_unit', key_secret: 'unit_secret' };
const target = (over: Partial<BillingSyncTarget> = {}): BillingSyncTarget => ({
  provider: 'RAZORPAY',
  interval: 'MONTH',
  product_id: 'aramo_sign_personal_standard',
  plan_id: '019a0000-0000-7000-8000-000000000001',
  plan_key: 'aramo-sign-standard-personal-v1',
  display_name: 'Standard',
  description: '25 sends a month and 1 GB storage',
  plan_version_id: VERSION,
  version_number: 2,
  prices: [{ country: 'IN', currency: 'INR', amount_minor: 89900 }],
  known_external_ref: null,
  stop_countries: [],
  review_screenshot: null,
  ...over,
});

function razorpay(opts: { configured?: boolean; enabled?: boolean } = {}) {
  const plans: Record<string, unknown>[] = [];
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const fake = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('rzp_test_unit:unit_secret').toString('base64')}`);
    const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ method, path: u.pathname, body });
    const json = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s });
    if (u.pathname === '/v1/plans' && method === 'GET') {
      const count = Number(u.searchParams.get('count'));
      const skip = Number(u.searchParams.get('skip'));
      const newestFirst = [...plans].reverse();
      const items = newestFirst.slice(skip, skip + count);
      return json(200, { entity: 'collection', count: items.length, items });
    }
    if (u.pathname === '/v1/plans' && method === 'POST') {
      const p = { id: `plan_${plans.length + 1}`, entity: 'plan', ...body };
      plans.push(p);
      return json(200, p);
    }
    return json(500, { error: { description: 'unexpected' } });
  };
  const w = new RazorpayCatalogWriter(fake, {
    credentials: () => (opts.configured === false ? undefined : CREDS),
    base: () => 'https://razorpay.test',
    enabled: () => opts.enabled !== false,
  });
  return { w, plans, calls };
}

describe('India Billing §4.6 RazorpayCatalogWriter', () => {
  it('IB-C-1 creates one monthly INR plan for the version with the Aramo notes; the plan id is the purchase link', async () => {
    const { w, plans, calls } = razorpay();
    const out = await w.sync(target());
    expect(out).toEqual({ status: 'SYNCED', origin: 'CREATED', external_ref: null, external_price_ref: 'plan_1', store_state: null, detail: null });
    expect(plans).toHaveLength(1);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      period: 'monthly',
      interval: 1,
      item: { name: 'Standard', amount: 89900, currency: 'INR', description: '25 sends a month and 1 GB storage' },
      notes: { aramo_plan_key: 'aramo-sign-standard-personal-v1', aramo_plan_version_id: VERSION, aramo_product_id: 'aramo_sign_personal_standard' },
    });
    // No tax parameter of any kind is sent (CCP-C5).
    expect(JSON.stringify(calls)).not.toMatch(/tax/i);
  });

  it('IB-C-2 a retry adopts the plan the version already has (matched by notes) and never creates a second one', async () => {
    const { w, plans } = razorpay();
    await w.sync(target());
    const again = await w.sync(target());
    expect(again).toMatchObject({ origin: 'ADOPTED', external_price_ref: 'plan_1' });
    const known = await w.sync(target({ known_external_ref: 'x' }));
    expect(known).toMatchObject({ origin: 'EXISTING', external_price_ref: 'plan_1' });
    expect(plans).toHaveLength(1);
  });

  it('IB-C-3 adopts an existing plan made outside this run (another page of the list), and refuses one with different terms', async () => {
    const { w, plans } = razorpay();
    for (let i = 0; i < 150; i++) plans.push({ id: `plan_other_${i}`, period: 'monthly', interval: 1, item: { amount: 100, currency: 'INR' }, notes: { aramo_plan_version_id: `v-${i}` } });
    plans.unshift({ id: 'plan_seed', period: 'monthly', interval: 1, item: { amount: 89900, currency: 'INR' }, notes: { aramo_plan_version_id: VERSION, aramo_product_id: 'aramo_sign_personal_standard' } });
    expect(await w.sync(target())).toMatchObject({ origin: 'ADOPTED', external_price_ref: 'plan_seed' });
    expect(plans).toHaveLength(151);
    const err = await w.sync(target({ prices: [{ country: 'IN', currency: 'INR', amount_minor: 99900 }] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingSyncError);
    expect((err as BillingSyncError).code).toBe('PROVIDER_REJECTED');
    expect(plans).toHaveLength(151);
  });

  it('IB-C-4 Q8: a version with no IN / INR monthly price is not sold in India (typed outcome, nothing created, no preview)', async () => {
    const { w, plans, calls } = razorpay();
    const t = target({ prices: [] });
    const err = await w.sync(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingNotSellableError);
    expect((err as BillingNotSellableError).reason).toBe('not_sellable_in_region');
    expect((err as BillingNotSellableError).retryable).toBe(false);
    expect(plans).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await w.preview(t)).toEqual([]);
    expect(await w.preview(target())).toEqual([{ country: 'IN', currency: 'INR', amount_minor: 89900, available: true, nearest: [] }]);
  });

  it('IB-C-5 G-2 / G-4: without credentials, or without SIGN_RAZORPAY_BILLING_ENABLED, the writer is NOT_CONFIGURED and calls nothing', async () => {
    for (const opts of [{ configured: false }, { enabled: false }]) {
      const { w, calls } = razorpay(opts);
      expect(w.configured()).toBe(false);
      const err = await w.sync(target()).catch((e: unknown) => e);
      expect((err as BillingSyncError).code).toBe('NOT_CONFIGURED');
      expect(await w.liveCountries(target())).toBeNull();
      expect(calls).toHaveLength(0);
    }
    expect(razorpay().w.configured()).toBe(true);
  });

  it('IB-C-6 live countries and live prices: India once a plan of the product exists; the version plan price', async () => {
    const { w } = razorpay();
    expect(await w.liveCountries(target())).toBeNull();
    expect(await w.livePrices(target())).toEqual([{ country: 'IN', currency: 'INR', amount_minor: null }]);
    await w.sync(target());
    expect(await w.liveCountries(target())).toEqual(['IN']);
    expect(await w.livePrices(target())).toEqual([{ country: 'IN', currency: 'INR', amount_minor: 89900 }]);
  });

  it('IB-C-7 a provider 4xx is PROVIDER_REJECTED, 5xx TRANSIENT, 401 NOT_CONFIGURED', async () => {
    for (const [status, code] of [[400, 'PROVIDER_REJECTED'], [503, 'TRANSIENT'], [401, 'NOT_CONFIGURED']] as const) {
      const w = new RazorpayCatalogWriter(async () => new Response('{"error":{}}', { status }), { credentials: () => CREDS, base: () => 'https://razorpay.test', enabled: () => true });
      expect(((await w.sync(target()).catch((e: unknown) => e)) as BillingSyncError).code).toBe(code);
    }
  });
});

// ---- the region-aware sync target --------------------------------------------------------------

function versionRow(regional: boolean) {
  const base = planVersionContentFromRows({
    plan: { key: 'aramo-sign-standard-personal-v1', product_key: 'sign', name: 'Standard', description: 'Personal Standard', tenant_kind: 'PERSONAL', sales_model: 'SELF_SERVICE', list_price_minor: 1000, currency: 'USD', reference_price_minor: null, reference_price_substantiated: false, billing_interval: 'MONTH', commitment_months: null, eligibility: null, support_tier: null },
    allowances: [],
    allowance_windows: [],
    capacities: [],
    features: [],
  });
  const content = regional
    ? { ...base, regional_prices: [{ country: 'BR', currency: 'BRL', amount_minor: 4990, interval: 'MONTH' }, { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' }] }
    : base;
  return { id: VERSION, plan_id: 'plan-1', version_number: 2, content, content_checksum: planVersionChecksum(content) };
}

function products(regional: boolean) {
  const prisma = {
    planVersion: { findUnique: async () => versionRow(regional) },
    billingProduct: { findUnique: async () => null },
    billingAsset: { findUnique: async () => null },
  };
  return new BillingProductsService(prisma as unknown as PrismaService, {} as PlanVersionRepository, []);
}

describe('India Billing Q8 BillingProductsService.targetFor (region-aware)', () => {
  it('IB-T-1 a Razorpay target carries only the IN / INR monthly price and the plan description', async () => {
    const t = await products(true).targetFor(VERSION, 'RAZORPAY', 'MONTH', 'aramo_sign_personal_standard', null);
    expect(t.prices).toEqual([{ country: 'IN', currency: 'INR', amount_minor: 89900 }]);
    expect(t.description).toBe('Personal Standard');
  });
  it('IB-T-2 a version without an IN price yields an empty Razorpay target (not an error)', async () => {
    const t = await products(false).targetFor(VERSION, 'RAZORPAY', 'MONTH', 'aramo_sign_personal_standard', null);
    expect(t.prices).toEqual([]);
  });
  it('IB-T-3 Stripe and store targets are unchanged: the US list price first, then every regional price', async () => {
    const s = await products(true).targetFor(VERSION, 'STRIPE', 'MONTH', 'aramo_sign_personal_standard', null);
    expect(s.prices).toEqual([
      { country: 'US', currency: 'USD', amount_minor: 1000 },
      { country: 'BR', currency: 'BRL', amount_minor: 4990 },
      { country: 'IN', currency: 'INR', amount_minor: 89900 },
    ]);
    const a = await products(true).targetFor(VERSION, 'APP_STORE', 'MONTH', 'ai.aramo.sign.personal_standard.monthly', null);
    expect(a.prices).toEqual(s.prices);
    expect(a.description).toBe('');
    await expect(products(true).targetFor(VERSION, 'STRIPE', 'YEAR', 'x', null)).rejects.toThrow(/no US YEAR list price/);
  });
});

// ---- the governed BILLING_REGION_CHANGE apply ---------------------------------------------------

const REQ = '019a0000-0000-7000-8000-00000000cc01';
const REQUESTER = '019a0000-0000-7000-8000-00000000aa01';
const IN_ENTITY = { id: '019a0000-0000-7000-8000-0000000a1e02', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false, registration: {} as Record<string, string> };
const GSTIN = '27AAPFU0939F1ZV';

function request(payload: Record<string, unknown>, state = 'APPROVED'): CommercialChangeRequestRow {
  const t = new Date('2026-11-13T10:00:00Z');
  return {
    id: REQ, action_type: 'BILLING_REGION_CHANGE', kind: 'NORMAL', state, tenant_id: null, product_key: null, payload, payload_checksum: 'c', required_chain: {},
    policy_version_id: '019a0000-0000-7000-8000-00000000bb01', policy_checksum: 'p', requested_by: REQUESTER, reason: 'India setup', idempotency_key: 'k',
    created_at: t, submitted_at: t, expires_at: null, approved_at: t, rejected_at: null, rejected_by: null, rejection_reason: null, withdrawn_at: null, expired_at: null,
    apply_attempts: 0, applied_at: null, updated_at: t,
  };
}

/** In-memory subscription schema slice; a throwing transaction restores its snapshot (rollback). */
function world(payload: Record<string, unknown>, opts: { configured?: boolean; state?: string } = {}) {
  const state = {
    req: request(payload, opts.state),
    entity: { ...IN_ENTITY },
    region: { country: 'IN', gateway: 'RAZORPAY', currency: 'INR', selling_entity_id: IN_ENTITY.id, enabled: false, personal_web_enabled: false, business_web_enabled: false, price_tax_mode: 'UNSET', updated_by: 'migration' as string | null },
    audit: [] as { event_type: string; payload: Record<string, unknown> }[],
    locks: [] as string[],
  };
  const withEntity = () => ({ ...state.region, selling_entity: { ...state.entity } });
  const db = {
    $executeRawUnsafe: async (sql: string) => {
      state.locks.push(sql);
      return 1;
    },
    commercialChangeRequest: {
      findUniqueOrThrow: async () => ({ ...state.req }),
      findUnique: async () => ({ ...state.req }),
      update: async (a: { data: Partial<CommercialChangeRequestRow> }) => {
        Object.assign(state.req, a.data);
        return { ...state.req };
      },
      findMany: async () => (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED'].includes(state.req.state) ? [{ id: state.req.id, state: state.req.state, requested_by: state.req.requested_by, created_at: state.req.created_at, expires_at: null }] : []),
    },
    commercialApproval: { findMany: async () => [{ id: 'ap1', step_index: 0, approver_user_id: 'fin', attestation_id: 'att', created_at: new Date('2026-11-13T10:05:00Z') }] },
    billingRegion: {
      findUnique: async (a: { where: { country: string } }) => (a.where.country === 'IN' ? withEntity() : null),
      findMany: async () => [withEntity()],
      update: async (a: { data: Record<string, unknown> }) => {
        const { updated_at: _u, ...d } = a.data;
        Object.assign(state.region, d);
        return withEntity();
      },
    },
    sellingEntity: {
      findUnique: async () => ({ registration: state.entity.registration }),
      update: async (a: { data: Record<string, unknown> }) => {
        const { updated_at: _u, ...d } = a.data;
        Object.assign(state.entity, d);
        return state.entity;
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const snap = structuredClone({ req: state.req, entity: state.entity, region: state.region, audit: state.audit });
      try {
        return await fn(db);
      } catch (e) {
        Object.assign(state, structuredClone(snap));
        throw e;
      }
    },
  };
  const audit = { append: async (e: { event_type: string; payload?: Record<string, unknown> }) => void state.audit.push({ event_type: e.event_type, payload: e.payload ?? {} }) } as unknown as CommercialAuditRepository;
  const operators = { readOperator: async () => ({ scopes: ['platform:catalog:draft', 'platform:approval:read'], role_keys: ['catalog_manager'], attested: true }) } as unknown as CommercialOperatorRepository;
  const changeRequests = { assertApplyEligible: async () => undefined, expireApplyIfDue: async () => false } as unknown as CommercialChangeRequestService;
  const regions = new BillingRegionService(db as unknown as PrismaService, () => opts.configured ?? false);
  const prisma = db as unknown as PrismaService;
  const svc = new CommercialBillingRegionApplyService(prisma, audit, operators, changeRequests, regions, () => new Date('2026-11-13T11:00:00Z'));
  const dispatcher = new CommercialApplyService(prisma, audit, operators, changeRequests, () => new Date('2026-11-13T11:00:00Z'), undefined, undefined, undefined, svc);
  const reads = new CommercialBillingRegionReadService(prisma, regions);
  return { state, svc, dispatcher, reads };
}

const ACTOR = { user_id: REQUESTER, actor_kind: 'user' as const, scopes: ['platform:catalog:draft', 'platform:approval:read'] };
const CTX = { platform_tenant_id: 'platform', correlation_id: 'corr-1' };

describe('India Billing Q3 CommercialBillingRegionApplyService', () => {
  it('IB-AP-1 an approved change is applied through the shared apply command: region + entity written, audited, APPLIED', async () => {
    const w = world({ country: 'IN', personal_web_enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { legal_name: 'Aramo India Private Limited', registration: { gstin: GSTIN, state_code: '27' } } });
    const out = await w.dispatcher.apply(ACTOR, REQ, CTX);
    expect(out).toMatchObject({ application: null, catalog_application: null, replayed: false });
    expect(out.request.state).toBe('APPLIED');
    expect(out.request.apply_attempts).toBe(1);
    expect(w.state.region).toMatchObject({ enabled: false, personal_web_enabled: true, price_tax_mode: 'INCLUSIVE', updated_by: REQUESTER });
    expect(w.state.entity).toMatchObject({ legal_name: 'Aramo India Private Limited', registration: { gstin: GSTIN, state_code: '27' } });
    expect(w.state.audit.map((a) => a.event_type)).toEqual(['COMMERCIAL_BILLING_REGION_CHANGED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    const changed = w.state.audit[0]!.payload;
    expect(changed).toMatchObject({ country: 'IN', registration_keys_set: ['gstin', 'state_code'], from: { personal_web_enabled: false }, to: { personal_web_enabled: true } });
    // §5 — the registration values never reach the audit stream.
    expect(JSON.stringify(w.state.audit)).not.toContain(GSTIN);
    expect(w.state.locks[0]).toMatch(/subscription\.billing_region:/);
  });

  it('IB-AP-2 G-3: switching India ON with the gateway unconfigured fails: rolled back, APPLY_FAILED with the reason, retryable', async () => {
    const w = world({ country: 'IN', enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true } });
    const err = await w.svc.apply(ACTOR, w.state.req, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommercialApplyFailedError);
    expect((err as CommercialApplyFailedError).code).toBe('BILLING_REGION_GATEWAY_NOT_CONFIGURED');
    expect((err as CommercialApplyFailedError).explanation).toMatch(/^Add the gateway keys on the server first/);
    expect((err as CommercialApplyFailedError).request_state).toBe('APPLY_FAILED');
    expect(w.state.req).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1 });
    expect(w.state.region).toMatchObject({ enabled: false, price_tax_mode: 'UNSET' });
    expect(w.state.entity.active).toBe(false);
    expect(w.state.audit.map((a) => [a.event_type, a.payload['failure']])).toEqual([['COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED', 'BILLING_REGION_GATEWAY_NOT_CONFIGURED']]);
  });

  it('IB-AP-3 each G-3 refusal has its own code and plain-words explanation', async () => {
    expect(BILLING_REGION_APPLY_FAILURE_CODES).toMatchObject({
      gateway_not_configured: 'BILLING_REGION_GATEWAY_NOT_CONFIGURED',
      selling_entity_inactive: 'BILLING_REGION_SELLING_ENTITY_INACTIVE',
      price_tax_mode_unset: 'BILLING_REGION_PRICE_TAX_MODE_UNSET',
    });
    const inactive = world({ country: 'IN', enabled: true, price_tax_mode: 'INCLUSIVE' }, { configured: true });
    const e1 = (await inactive.svc.apply(ACTOR, inactive.state.req, CTX).catch((e: unknown) => e)) as CommercialApplyFailedError;
    expect([e1.code, e1.explanation.split(':')[0]]).toEqual(['BILLING_REGION_SELLING_ENTITY_INACTIVE', 'Activate the selling entity']);
    const unset = world({ country: 'IN', enabled: true, selling_entity: { active: true } }, { configured: true });
    const e2 = (await unset.svc.apply(ACTOR, unset.state.req, CTX).catch((e: unknown) => e)) as CommercialApplyFailedError;
    expect([e2.code, e2.explanation.split(':')[0]]).toEqual(['BILLING_REGION_PRICE_TAX_MODE_UNSET', 'Set how prices handle GST']);
  });

  it('IB-AP-4 a retry after the keys are set applies; an APPLIED request replays without writing', async () => {
    const w = world({ country: 'IN', enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true } }, { state: 'APPLY_FAILED' });
    w.state.req.apply_attempts = 1;
    const ok = new CommercialBillingRegionApplyService(
      w.svc.prisma,
      w.svc.audit,
      w.svc.operators,
      { assertApplyEligible: async () => undefined, expireApplyIfDue: async () => false } as unknown as CommercialChangeRequestService,
      new BillingRegionService(w.svc.prisma, () => true),
    );
    const out = await ok.apply(ACTOR, w.state.req, CTX);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
    expect(w.state.region.enabled).toBe(true);
    const audits = w.state.audit.length;
    const again = await ok.apply(ACTOR, w.state.req, CTX);
    expect(again).toMatchObject({ replayed: true, region: null });
    expect(w.state.audit).toHaveLength(audits);
  });

  it('IB-AP-5 only the requester applies (an audited refusal, nothing changes)', async () => {
    const w = world({ country: 'IN', personal_web_enabled: true });
    const err = await w.svc.apply({ ...ACTOR, user_id: 'someone-else' }, w.state.req, CTX).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('NOT_REQUESTER');
    expect(w.state.req.state).toBe('APPROVED');
    expect(w.state.audit.map((a) => a.event_type)).toEqual(['COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED']);
  });
});

describe('India Billing §4.10 CommercialBillingRegionReadService', () => {
  it('IB-RD-1 list shows the gateway configured state and the G-3 refusal; detail adds registration and open requests', async () => {
    const w = world({ country: 'IN', personal_web_enabled: true });
    w.state.entity.registration = { gstin: GSTIN };
    const [india] = await w.reads.list();
    expect(india).toMatchObject({ country: 'IN', gateway: 'RAZORPAY', gateway_configured: false, enable_refusal: 'gateway_not_configured' });
    const d = await w.reads.detail('in');
    expect(d).toMatchObject({ country: 'IN', registration: { gstin: GSTIN }, open_requests: [{ id: REQ, state: 'APPROVED' }] });
    expect(await w.reads.detail('ZZ')).toBeNull();
    expect(await w.reads.listDetailed()).toEqual([d]);
  });
});
