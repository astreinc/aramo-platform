import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { BUSINESS, CR, INCLUDED, clock, type D4Harness } from './ccp-d4-harness.js';

// CCP-D4 — one scenario per commercial action type (the closed COMMERCIAL_ACTION_TYPES list), each
// built ONLY through the HTTP surface of the real AppModule (fixtures that model pre-existing
// tenant state — a governed row, a Stripe-owned PAST_DUE row, an entitlement, a catalog plan — are
// inserted raw, as the slice specs do). A scenario knows its requester role, its chain (the role of
// each step, TD-A3-2 / TD-A3-6 / Q1 / Q2 / Q7) and how it is applied:
//   'apply'    POST …/{id}/apply by the requester (A6, A7, A8 NORMAL, B2-backend, B5-R)
//   'convert'  POST …/{id}/convert by the requester (C2)
//   'approval' applied inside the completing approval (A9 role change)
//   null       not applyable in v1 (CREDIT / DISCOUNT: C4 NOT DELIVERED)

export type ApplyRoute = 'apply' | 'convert' | 'approval' | null;
export interface Created {
  id: string;
  tenant_id: string | null;
}
export interface Scenario {
  action: string;
  requester: string;
  /** The default approver alias of each chain step, in order (a distinct human per step). */
  chain: string[];
  /** The role each chain step requires. */
  stepRoles: string[];
  apply: ApplyRoute;
  /** Creates the request (DRAFT, or PENDING for the support-extension escalation) as `who`. */
  create(h: D4Harness, who?: string): Promise<{ res: { status: number; body: Record<string, unknown> }; tenant_id: string | null }>;
}

let seq = 0;
export const key = (p = 'd4'): string => `${p}-${String(++seq).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;

export async function tenant(h: D4Harness, name = 'D4 tenant'): Promise<string> {
  const r = await h.pg.query(`INSERT INTO identity."Tenant" (id, name, kind, updated_at) VALUES (gen_random_uuid(), $1, 'BUSINESS', now()) RETURNING id`, [name]);
  return r.rows[0].id as string;
}
export async function version(h: D4Harness, plan_key: string): Promise<string> {
  const r = await h.pg.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = $1 AND v.status = 'PUBLISHED'`, [plan_key]);
  return r.rows[0].id as string;
}
/** An open governed MANUAL Sign BASE row (a pre-existing subscription), raw. */
export async function governedRow(h: D4Harness, tenant_id: string, plan_key = INCLUDED): Promise<string> {
  const id = randomUUID();
  await h.pg.query(
    `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
     SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), 'sign', 'BASE', now() - interval '10 days', 'MANUAL', 'ccp-d4' FROM subscription."Plan" p WHERE p.key = $3`,
    [id, tenant_id, plan_key],
  );
  return id;
}
/** A Stripe-owned (SELF_SERVICE) PAST_DUE Sign row whose grace ended a day ago (a support-extension target). */
export async function pastDueRow(h: D4Harness, tenant_id: string): Promise<string> {
  const id = randomUUID();
  await h.pg.query(
    `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, grace_until, billing_provider, billing_account_ref, billing_subscription_ref)
     SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now() - interval '20 days', 'SELF_SERVICE', 'ccp-d4', 'PAST_DUE', now() - interval '1 day', 'STRIPE', $3, $4
       FROM subscription."Plan" p WHERE p.key = $5`,
    [id, tenant_id, `acct_${tenant_id}`, `sub_${id}`, BUSINESS],
  );
  return id;
}
export async function entitle(h: D4Harness, tenant_id: string, capability = 'sign'): Promise<void> {
  await h.pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability") ON CONFLICT DO NOTHING`, [tenant_id, capability]);
}
/** A fresh test-only Sign plan copied from the included plan's live rows, with its v1 PUBLISHED; `draft` adds a v2 DRAFT. */
export async function freshPlan(h: D4Harness, draft: boolean): Promise<{ plan_id: string; published: string; draft: string | null }> {
  const plan = randomUUID();
  await h.pg.query(
    `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
     SELECT $1::uuid, $2, 'D4 plan', false, description, tenant_kind, sales_model, 'ACTIVE', 970, product_key FROM subscription."Plan" WHERE key = $3`,
    [plan, `aramo-sign-d4-${plan.slice(0, 8)}`, INCLUDED],
  );
  for (const k of ['PlanAllowance', 'PlanCapacity']) {
    const cols = k === 'PlanAllowance' ? 'allowance_key, included_quantity, unlimited, period' : 'capacity_key, limit_quantity, unlimited';
    await h.pg.query(`INSERT INTO subscription."${k}" (plan_id, ${cols}) SELECT $1::uuid, ${cols} FROM subscription."${k}" WHERE plan_id = (SELECT id FROM subscription."Plan" WHERE key = $2)`, [plan, INCLUDED]);
  }
  const ids: string[] = [];
  for (const n of draft ? [1, 2] : [1]) {
    const v = await h.pg.query(
      `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'ccp-d4', now()
         FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x RETURNING id`,
      [plan, n],
    );
    ids.push(v.rows[0].id as string);
    if (n === 1) await h.pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [v.rows[0].id]);
  }
  return { plan_id: plan, published: ids[0] as string, draft: ids[1] ?? null };
}

/**
 * A test-only operator plan whose terms equal the included plan's (a same-terms SUBSCRIPTION_CHANGE
 * target: no usage treatment is needed, T8 / DR-A6). Created once per database.
 */
export async function changeTarget(h: D4Harness): Promise<string> {
  const k = 'aramo-sign-d4-change-target';
  if ((await h.pg.query(`SELECT 1 FROM subscription."Plan" WHERE key = $1`, [k])).rows.length === 0) {
    const plan = randomUUID();
    await h.pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'D4 change target', false, description, tenant_kind, sales_model, 'ACTIVE', 971, product_key FROM subscription."Plan" WHERE key = $3`,
      [plan, k, INCLUDED],
    );
    for (const t of ['PlanAllowance', 'PlanCapacity']) {
      const cols = t === 'PlanAllowance' ? 'allowance_key, included_quantity, unlimited, period' : 'capacity_key, limit_quantity, unlimited';
      await h.pg.query(`INSERT INTO subscription."${t}" (plan_id, ${cols}) SELECT $1::uuid, ${cols} FROM subscription."${t}" WHERE plan_id = (SELECT id FROM subscription."Plan" WHERE key = $2)`, [plan, INCLUDED]);
    }
    const v = await h.pg.query(
      `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
       SELECT gen_random_uuid(), $1::uuid, 1, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'ccp-d4', now() FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x RETURNING id`,
      [plan],
    );
    await h.pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [v.rows[0].id]);
  }
  return k;
}

/** The one DRAFT commercial policy version (created through the HTTP surface by finance_admin when none exists). */
export async function policyDraft(h: D4Harness): Promise<string> {
  const d = await h.pg.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'DRAFT'`);
  if (d.rows.length > 0) return d.rows[0].id as string;
  const active = (await h.pg.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id as string;
  const res = await h.post('finance_admin', '/platform/commercial/policy-versions', { source_version_id: active });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = (res.body.version?.id ?? res.body.id) as string;
  const edit = await h.call('finance_admin', 'PATCH', `/platform/commercial/policy-versions/${id}`, { content: { approval_expiry_hours: 48 } });
  expect(edit.status, JSON.stringify(edit.body)).toBe(200);
  return id;
}

const body = (action_type: string, tenant_id: string | null, payload: Record<string, unknown>) => ({
  action_type,
  ...(tenant_id === null ? {} : { tenant_id, product_key: 'sign' }),
  payload,
  reason: `D4 ${action_type}`,
  idempotency_key: key(action_type.toLowerCase()),
});

async function createVia(h: D4Harness, who: string, b: ReturnType<typeof body>) {
  const res = await h.post(who, CR, b);
  return { res: { status: res.status, body: res.body as Record<string, unknown> }, tenant_id: b.tenant_id ?? null };
}

export const SCENARIOS: Scenario[] = [
  {
    action: 'SUBSCRIPTION_OPEN', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      return createVia(h, who, body('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: await version(h, INCLUDED), replaces_subscription_id: null }));
    },
  },
  {
    action: 'SUBSCRIPTION_CHANGE', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      const sub = await governedRow(h, t);
      const target = await changeTarget(h);
      return createVia(h, who, body('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: target, plan_version_id: await version(h, target) }));
    },
  },
  {
    action: 'SUBSCRIPTION_END', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      return createVia(h, who, body('SUBSCRIPTION_END', t, { subscription_id: await governedRow(h, t) }));
    },
  },
  {
    action: 'ENTITLEMENT_GRANT', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      return createVia(h, who, body('ENTITLEMENT_GRANT', t, { capabilities: ['sign'] }));
    },
  },
  {
    action: 'ENTITLEMENT_REVOKE', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      await entitle(h, t, 'sign');
      return createVia(h, who, body('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] }));
    },
  },
  {
    action: 'CONVERSION', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'convert',
    async create(h, who = 'commercial_ops') {
      const t = await tenant(h);
      const gov = await governedRow(h, t);
      return createVia(h, who, body('CONVERSION', t, { direction: 'TO_SELF_SERVICE', governed_subscription_id: gov, plan_key: BUSINESS, plan_version_id: await version(h, BUSINESS), release_expires_at: new Date((clock.fixed ?? new Date()).getTime() + 10 * 24 * 3_600_000).toISOString() }));
    },
  },
  {
    action: 'SUPPORT_EXTENSION', requester: 'support_admin', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: 'apply',
    // The escalated (out-of-limit, Q7) extension: POST /support-extensions with 20 days creates a
    // NORMAL request already PENDING_APPROVAL (the bounded EXCEPTION path applies without a chain).
    async create(h, who = 'support_admin') {
      const t = await tenant(h);
      const sub = await pastDueRow(h, t);
      const res = await h.post(who, '/platform/commercial/support-extensions', { tenant_id: t, subscription_id: sub, product_key: 'sign', requested_days: 20, reason: 'D4 escalated extension', idempotency_key: key('se') });
      return { res: { status: res.status, body: res.body as Record<string, unknown> }, tenant_id: t };
    },
  },
  {
    action: 'CREDIT', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: null,
    async create(h, who = 'commercial_ops') {
      return createVia(h, who, body('CREDIT', await tenant(h), { amount_minor: 1_000, currency: 'USD' }));
    },
  },
  {
    action: 'DISCOUNT', requester: 'commercial_ops', chain: ['finance_admin'], stepRoles: ['finance_admin'], apply: null,
    async create(h, who = 'commercial_ops') {
      return createVia(h, who, body('DISCOUNT', await tenant(h), { discount_bps: 500 }));
    },
  },
  {
    action: 'PLAN_VERSION_PUBLISH', requester: 'catalog_manager', chain: ['finance_admin', 'platform_owner'], stepRoles: ['finance_admin', 'platform_owner'], apply: 'apply',
    async create(h, who = 'catalog_manager') {
      const p = await freshPlan(h, true);
      return createVia(h, who, body('PLAN_VERSION_PUBLISH', null, { plan_version_id: p.draft as string }));
    },
  },
  {
    action: 'PLAN_RETIRE', requester: 'catalog_manager', chain: ['finance_admin', 'platform_owner'], stepRoles: ['finance_admin', 'platform_owner'], apply: 'apply',
    async create(h, who = 'catalog_manager') {
      const p = await freshPlan(h, false);
      return createVia(h, who, body('PLAN_RETIRE', null, { plan_version_id: p.published }));
    },
  },
  {
    action: 'POLICY_ACTIVATE', requester: 'finance_admin', chain: ['finance_admin_2', 'platform_owner'], stepRoles: ['finance_admin', 'platform_owner'], apply: 'apply',
    async create(h, who = 'finance_admin') {
      return createVia(h, who, body('POLICY_ACTIVATE', null, { policy_version_id: await policyDraft(h) }));
    },
  },
  {
    action: 'ROLE_GRANT', requester: 'platform_owner', chain: ['platform_owner_2'], stepRoles: ['platform_owner'], apply: 'approval',
    async create(h, who = 'platform_owner') {
      const subject = await h.operator(`subject-${key()}`, []);
      return createVia(h, who, body('ROLE_GRANT', null, { subject_user_id: subject, role_key: 'support_admin' }));
    },
  },
  {
    action: 'ROLE_REVOKE', requester: 'platform_owner', chain: ['platform_owner_2'], stepRoles: ['platform_owner'], apply: 'approval',
    async create(h, who = 'platform_owner') {
      const subject = await h.operator(`subject-${key()}`, ['catalog_manager']);
      return createVia(h, who, body('ROLE_REVOKE', null, { subject_user_id: subject, role_key: 'catalog_manager' }));
    },
  },
];

/** Escalated money actions (≥ the policy threshold, A2-B inclusive): Finance → Owner. */
export const ESCALATED: Scenario[] = [
  {
    action: 'CREDIT', requester: 'commercial_ops', chain: ['finance_admin', 'platform_owner'], stepRoles: ['finance_admin', 'platform_owner'], apply: null,
    async create(h, who = 'commercial_ops') {
      return createVia(h, who, body('CREDIT', await tenant(h), { amount_minor: 50_000, currency: 'USD' }));
    },
  },
  {
    action: 'DISCOUNT', requester: 'commercial_ops', chain: ['finance_admin', 'platform_owner'], stepRoles: ['finance_admin', 'platform_owner'], apply: null,
    async create(h, who = 'commercial_ops') {
      return createVia(h, who, body('DISCOUNT', await tenant(h), { discount_bps: 2_000 }));
    },
  },
];

export const idOf = (c: { res: { body: Record<string, unknown> } }): string => (c.res.body['request'] as { id: string }).id;
export const stateOf = (c: { res: { body: Record<string, unknown> } }): string => (c.res.body['request'] as { state: string }).state;

/** Created by the scenario's requester and submitted (PENDING_APPROVAL). */
export async function pending(h: D4Harness, s: Scenario, requester = s.requester): Promise<Created> {
  const c = await s.create(h, requester);
  expect(c.res.status, `${s.action} create ${JSON.stringify(c.res.body)}`).toBeGreaterThanOrEqual(200);
  expect(c.res.status, `${s.action} create ${JSON.stringify(c.res.body)}`).toBeLessThan(300);
  const id = idOf(c);
  if (stateOf(c) === 'DRAFT') {
    const sub = await h.post(requester, `${CR}/${id}/submit`);
    expect(sub.status, `${s.action} submit ${JSON.stringify(sub.body)}`).toBe(200);
  }
  return { id, tenant_id: c.tenant_id };
}

/** Pending, then every step filled by `approvers[i]` (default: the step role's alias). */
export async function approved(h: D4Harness, s: Scenario, approvers: string[] = s.chain, requester = s.requester): Promise<Created> {
  const c = await pending(h, s, requester);
  for (const [i, who] of approvers.entries()) {
    const res = await h.post(who, `${CR}/${c.id}/approvals`, { step_index: i });
    expect(res.status, `${s.action} approve step ${i} as ${who} ${JSON.stringify(res.body)}`).toBe(201);
  }
  return c;
}

export const applyPath = (s: Scenario, id: string): string => `${CR}/${id}/${s.apply === 'convert' ? 'convert' : 'apply'}`;

export async function requestState(h: D4Harness, id: string): Promise<string> {
  return (await h.pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state as string;
}
export async function approvalRows(h: D4Harness, id: string): Promise<string[]> {
  return (await h.pg.query(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1 ORDER BY step_index`, [id])).rows.map((r) => r.j as string);
}

/**
 * Leaves no request holding a global slot: a DRAFT / PENDING request is withdrawn by its
 * requester; an APPROVED POLICY_ACTIVATE (one open activation at a time) is applied by it.
 */
export async function settle(h: D4Harness, s: Scenario, id: string, requester = s.requester): Promise<void> {
  const st = await requestState(h, id);
  if (st === 'DRAFT' || st === 'PENDING_APPROVAL') {
    const r = await h.post(requester, `${CR}/${id}/withdraw`);
    // A request whose approval TTL has lapsed is expired lazily by the withdraw itself (409, EXPIRED).
    if (!(r.status === 409 && r.body?.error?.details?.state === 'EXPIRED')) expect(r.status, `${s.action} withdraw ${JSON.stringify(r.body)}`).toBe(200);
  } else if (st === 'APPROVED' && s.action === 'POLICY_ACTIVATE') {
    const r = await h.post(requester, `${CR}/${id}/apply`);
    expect(r.status, `${s.action} settle apply ${JSON.stringify(r.body)}`).toBe(200);
  }
}
