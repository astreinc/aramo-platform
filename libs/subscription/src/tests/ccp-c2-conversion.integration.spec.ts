import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingRefusedError } from '../lib/billing/subscription-lifecycle.service.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { ConversionApplyFailedError } from '../lib/commercial/commercial-conversion.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { publishTestPlanV1 } from './fixtures/ccp-a5.js';
import { addOperator, applyCcpA6Schema, grantRole, revokeRole } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C2Harness, c2Harness } from './support/ccp-c2.js';

// CCP-C2 (PBD §5.2 row C2, §7.2; Conversion Rule C-11…C-15, C-21…C-23, C-29) — governed manual ↔
// self-service conversion on real Postgres 17 with the real change-request, apply, conversion,
// lifecycle, command and inbox services; Stripe is a fake (no network, no key). Test IDs are cited
// by doc/ccp/slices/CCP-C2-acceptance.md:
//   C2-REL-*   governed → self-service: release consumed exactly once; expired → the hold
//   C2-GOV-*   self-service → governed: durable command; governed row only after the confirmed end
//   C2-C8-*    PBD §7.2 / C-29: a held activation is resolved through the C2 conversion path
//   C2-TDC14-* Architect verification of TD-C1-4 (2026-10-25)
//   C2-AUTH-*, C2-DB-*, C2-HIST-*, C2-TX-*, C2-AD-*

const T0 = new Date('2026-10-25T12:00:00.000Z');
const H = 3_600_000;
const GOV_PLAN = 'aramo-sign-c2-test-governed';
const GOV_PLAN_ID = '019a0000-5150-7000-8000-0000000c2001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C2 governed manual <-> self-service conversion (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let probe: Client;
  let prisma: PrismaService;
  let h: C2Harness;
  let OPS: string;
  let OPS2: string;
  let FA: string;
  let FA2: string;
  let now = T0;
  let keyN = 0;
  let evtN = 0;
  const key = () => `c2-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_c2_${String(++evtN).padStart(6, '0')}`;
  const env = { ...process.env };
  const clock = () => now;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    probe = new Client({ connectionString: url });
    await probe.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business`;
    h = c2Harness(prisma, clock);
    h.billing.attachProbe(probe);
    OPS = await addOperator(pg, ['commercial_ops']);
    OPS2 = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    // GOV_PLAN: a governed (CONTACT_SALES) plan with the Standard Business terms and no commitment,
    // published as its v1 — the T8-defined (equal-terms) target of a self-service → governed test.
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'C2 governed test', false, description, tenant_kind, 'CONTACT_SALES', 'ACTIVE', 951, product_key FROM subscription."Plan" WHERE key = $3`,
      [GOV_PLAN_ID, GOV_PLAN, BUSINESS],
    );
    for (const t of ['PlanAllowance', 'PlanCapacity', 'PlanFeature', 'PlanAllowanceWindow']) {
      const cols = (await pg.query(`SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) c FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = $1 AND column_name <> 'plan_id'`, [t])).rows[0].c;
      if (cols !== null) await pg.query(`INSERT INTO subscription."${t}" (plan_id, ${cols}) SELECT $1::uuid, ${cols} FROM subscription."${t}" WHERE plan_id = (SELECT id FROM subscription."Plan" WHERE key = $2)`, [GOV_PLAN_ID, BUSINESS]);
    }
    await publishTestPlanV1(pg, GOV_PLAN_ID);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await probe?.end();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- fixtures ---------------------------------------------------------------------------

  const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0];
  const sub = (id: string) => one(`SELECT * FROM subscription."TenantSubscription" WHERE id = $1`, [id]);
  const rowJson = async (id: string) => (await one(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [id])).j as string;
  const openRows = async (t: string) => (await pg.query(`SELECT source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY source`, [t])).rows.map((r) => r.source as string);
  const openFlags = async (t: string) => (await pg.query(`SELECT reason FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY reason`, [t])).rows.map((r) => r.reason as string);
  const intentStatus = async (id: string) => (await one(`SELECT status FROM subscription."CheckoutIntent" WHERE id = $1`, [id])).status as string;
  const reqRow = (id: string) => one(`SELECT * FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id]);
  const releaseOf = (cr: string) => one(`SELECT * FROM subscription."CommercialConversionRelease" WHERE change_request_id = $1`, [cr]);
  const commandsOf = async (cr: string) => (await pg.query(`SELECT * FROM subscription."BillingProviderCommand" WHERE change_request_id = $1 ORDER BY created_at`, [cr])).rows;
  const auditTypes = async (cr: string) => (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [cr])).rows.map((r) => r.event_type as string);
  const entitlements = async (t: string) => (await pg.query(`SELECT capability::text c FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY 1`, [t])).rows.map((r) => r.c as string);
  async function dbError(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
      return 'OK';
    } catch (e) {
      return (e as Error).message;
    }
  }
  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof BillingRefusedError) return e.reason;
      if (e instanceof ConversionApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialChangeRequestError) return e.code;
      throw e;
    }
  }

  /** An APPROVED CONVERSION (Finance-only chain, TD-A3-2): requested by `requester`, approved by `approver`. */
  async function conversion(t: string, payload: Record<string, unknown>, requester = OPS, approver = FA): Promise<string> {
    const r = await h.changeRequests.create(as(requester, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload, reason: 'c2 conversion', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(requester, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(approver, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return r.request.id;
  }
  const applyAs = (id: string, user = OPS, role = 'commercial_ops') => h.conversions.apply(as(user, role), id, A6_CTX);

  /** A governed MANUAL row opened through the real governed path (approve + A6 apply). */
  async function governedTenant(): Promise<{ t: string; gov: string }> {
    const t = await newTenant(pg);
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'governed open', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    const gov = (await h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).application.subscription_id as string;
    return { t, gov };
  }
  const toSelfService = async (gov: string, o: { expires?: Date; held?: string } = {}) => ({
    direction: 'TO_SELF_SERVICE',
    governed_subscription_id: gov,
    plan_key: BUSINESS,
    plan_version_id: await publishedVersion(pg, BUSINESS),
    release_expires_at: (o.expires ?? new Date(now.getTime() + 24 * H)).toISOString(),
    ...(o.held !== undefined ? { held_subscription_ref: o.held } : {}),
  });
  const checkout = (tenant_id: string, at: Date = now) =>
    h.lifecycle.startCheckout({ product_key: 'sign', tenant_id, user_id: 'owner-1', user_email: 'o@acme.test', plan_key: BUSINESS, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true, at });
  const lastIntent = async (t: string) => (await one(`SELECT id FROM subscription."CheckoutIntent" WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [t])).id as string;
  const deliver = (ref: string, at: Date = now, id: string = evtId()) => h.inbox.receive({ id, type: 'subscription.updated', created: at, subscription_ref: ref }, 'sign', at);
  const sessionEvent = (session_ref: string, at: Date = now, id: string = evtId()) => h.inbox.receive({ id, type: 'checkout.session.expired', created: at, subscription_ref: null, checkout_session_ref: session_ref }, 'sign', at);
  /** Raw CheckoutIntent (CREATED) — a checkout that predates the governed row or the rule. */
  async function rawIntent(t: string): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [id, t, `cs_${id}`, '2026-10-20T09:00:00.000Z', BUSINESS],
    );
    return id;
  }
  /** A held activation (Conv. C-7): a governed tenant + a paid provider subscription from an old checkout. */
  async function heldTenant(): Promise<{ t: string; gov: string; intent: string; ref: string }> {
    const { t, gov } = await governedTenant();
    const intent = await rawIntent(t);
    const s = h.billing.state(t, intent);
    const held = await deliver(s.subscription_ref);
    expect(held).toMatchObject({ outcome: 'IGNORED' });
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    return { t, gov, intent, ref: s.subscription_ref };
  }
  /** A tenant with an open Stripe-owned SELF_SERVICE row (no commitment term). */
  async function selfServiceTenant(): Promise<{ t: string; ss: string; ref: string }> {
    const t = await newTenant(pg);
    const s = h.billing.state(t, randomUUID());
    const ss = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    return { t, ss, ref: s.subscription_ref };
  }
  const toGoverned = async (ss: string) => ({ direction: 'TO_GOVERNED', subscription_id: ss, plan_key: GOV_PLAN, plan_version_id: await publishedVersion(pg, GOV_PLAN) });

  // ---- governed → self-service (C-12) -----------------------------------------------------

  it('C2-REL-1 governed → self-service: the approved release is applied by its requester; it is consumed by exactly ONE checkout; the provider-confirmed activation ends the governed row and opens the SELF_SERVICE row in one transaction, linked and audited; replays change nothing', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const govBefore = await rowJson(gov);
    const cr = await conversion(t, await toSelfService(gov));
    const applied = await applyAs(cr);
    expect(applied).toMatchObject({ replayed: false, direction: 'TO_SELF_SERVICE', status: 'RELEASED', pending_provider: false, request: { state: 'APPLIED', apply_attempts: 1 }, release: { state: 'RELEASED', effective_state: 'RELEASED', governed_subscription_id: gov, intent_id: null } });
    expect(applied.application).toMatchObject({ action_type: 'CONVERSION', subscription_id: gov, attempt: 1 });
    expect(await rowJson(gov)).toBe(govBefore); // releasing never touches the governed row (C-21)
    expect(await applyAs(cr)).toMatchObject({ replayed: true, status: 'RELEASED' });

    now = new Date(T0.getTime() + H);
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    expect(await releaseOf(cr)).toMatchObject({ state: 'CONSUMED', intent_id: intent });
    expect(await rowJson(gov)).toBe(govBefore); // a consumed release still changes nothing (C2-D4)
    // Exactly once: a second checkout is refused as before the release.
    expect(await refusal(checkout(t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect((await h.conversions.view(cr)).status).toBe('CHECKOUT_STARTED');

    const s = h.billing.state(t, intent, { current_period_start: now });
    const evt = evtId();
    const r = await deliver(s.subscription_ref, now, evt);
    expect(r).toMatchObject({ outcome: 'APPLIED' });
    expect((r as { detail: string }).detail).toContain(`ended MANUAL; conversion ${cr}`);
    const g = await sub(gov);
    expect(g.ended_at).not.toBeNull();
    expect(g.status).toBe('CANCELED');
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    const rel = await releaseOf(cr);
    expect(rel).toMatchObject({ state: 'CONVERTED', intent_id: intent });
    const ss = await sub(rel.self_service_subscription_id);
    expect(ss).toMatchObject({ source: 'SELF_SERVICE', billing_subscription_ref: s.subscription_ref, ended_at: null });
    expect(await intentStatus(intent)).toBe('COMPLETED');
    expect(await openFlags(t)).toEqual([]);
    expect(await auditTypes(cr)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_CONVERSION_RELEASED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
      'COMMERCIAL_CONVERSION_RELEASE_CONSUMED',
      'COMMERCIAL_SUBSCRIPTION_ENDED',
      'COMMERCIAL_CONVERSION_COMPLETED',
    ]);
    expect((await h.conversions.view(cr)).status).toBe('CONVERTED');
    // Replays: the same event → DUPLICATE; a later event re-fetches the (unchanged) state; the
    // conversion happens once.
    expect(await deliver(s.subscription_ref, now, evt)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await deliver(s.subscription_ref, new Date(now.getTime() + H))).toMatchObject({ outcome: 'APPLIED', detail: 'ACTIVE -> ACTIVE' });
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND source = 'SELF_SERVICE'`, [t])).rows[0].n).toBe(1);
    expect(await auditTypes(cr)).toHaveLength(9);
  });

  it('C2-REL-2 an unconsumed release expires: at or after its expiry the checkout is refused (the hold stands), the read shows RELEASE_EXPIRED, the sweep records EXPIRED once (audited); the governed row is untouched', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const govBefore = await rowJson(gov);
    const cr = await conversion(t, await toSelfService(gov, { expires: new Date(T0.getTime() + H) }));
    await applyAs(cr);
    // Half-open: at exactly the expiry the release is gone.
    now = new Date(T0.getTime() + H);
    expect(await refusal(checkout(t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect((await h.conversions.view(cr)).release).toMatchObject({ state: 'RELEASED', effective_state: 'EXPIRED' });
    expect((await h.conversions.view(cr)).status).toBe('RELEASE_EXPIRED');
    expect(await h.conversions.expireReleases()).toBeGreaterThanOrEqual(1);
    expect(await releaseOf(cr)).toMatchObject({ state: 'EXPIRED', intent_id: null });
    expect(await h.conversions.expireReleases()).toBe(0);
    expect((await auditTypes(cr)).filter((e) => e === 'COMMERCIAL_CONVERSION_RELEASE_EXPIRED')).toHaveLength(1);
    expect(await rowJson(gov)).toBe(govBefore);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CheckoutIntent" WHERE tenant_id = $1`, [t])).rows[0].n).toBe(0);
  });

  it('C2-REL-3 the release binds exactly its own checkout: an older checkout of the tenant is still held; a non-sending first state keeps the governed row, the paid state converts', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const old = await rawIntent(t);
    const cr = await conversion(t, await toSelfService(gov));
    await applyAs(cr);
    // The pre-existing checkout completes: no release binds it → held (C-6/C-7), release untouched.
    const so = h.billing.state(t, old);
    expect(await deliver(so.subscription_ref)).toMatchObject({ outcome: 'IGNORED' });
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await releaseOf(cr)).toMatchObject({ state: 'RELEASED' });
    // The released checkout: incomplete first (never end a working subscription for an unpaid one).
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    const s = h.billing.state(t, intent, { provider_status: 'incomplete', current_period_start: now });
    expect(await deliver(s.subscription_ref)).toMatchObject({ outcome: 'IGNORED', detail: 'checkout INCOMPLETE; the open subscription is kept' });
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect(await releaseOf(cr)).toMatchObject({ state: 'CONSUMED' });
    h.billing.subs.set(s.subscription_ref, { ...s, provider_status: 'active' });
    expect(await deliver(s.subscription_ref)).toMatchObject({ outcome: 'APPLIED' });
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    expect(await releaseOf(cr)).toMatchObject({ state: 'CONVERTED' });
    expect((await sub(gov)).ended_at).not.toBeNull();
    // The older activation's hold is evidence: its flag row is kept (resolved only by its own next sync).
    expect((await one(`SELECT count(*)::int n FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND subscription_ref = $2`, [t, so.subscription_ref])).n).toBe(1);
  });

  it('C2-REL-4 release apply failures roll back and record APPLY_FAILED (retryable): expiry passed, window too long, a non-self-service plan, a non-governed target, a second live release', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    // Each case on its own tenant (an APPLY_FAILED request keeps the Q14 slot).
    const c1 = await conversion(t, await toSelfService(gov, { expires: new Date(T0.getTime() - 1) }));
    expect(await refusal(applyAs(c1))).toBe('FAILED:RELEASE_EXPIRY_PASSED');
    expect([(await reqRow(c1)).state, await releaseOf(c1)]).toEqual(['APPLY_FAILED', undefined]);
    const t2 = (await governedTenant()) as { t: string; gov: string };
    const c2 = await conversion(t2.t, await toSelfService(t2.gov, { expires: new Date(T0.getTime() + 31 * 24 * H) }));
    expect(await refusal(applyAs(c2))).toBe('FAILED:RELEASE_WINDOW_TOO_LONG');
    const t3 = await governedTenant();
    const c3 = await conversion(t3.t, { ...(await toSelfService(t3.gov)), plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) });
    expect(await refusal(applyAs(c3))).toBe('FAILED:PLAN_NOT_ASSIGNABLE');
    const t4 = await selfServiceTenant();
    const c4 = await conversion(t4.t, await toSelfService(t4.ss));
    expect(await refusal(applyAs(c4))).toBe('FAILED:TARGET_NOT_GOVERNED');
    expect(await openRows(t4.t)).toEqual(['SELF_SERVICE']);
    // A second live release of the same tenant × product.
    const t5 = await governedTenant();
    const a = await conversion(t5.t, await toSelfService(t5.gov));
    await applyAs(a);
    const b = await conversion(t5.t, await toSelfService(t5.gov));
    expect(await refusal(applyAs(b))).toBe('FAILED:RELEASE_EXISTS');
    expect((await reqRow(b)).apply_attempts).toBe(1);
    expect(await auditTypes(b)).toContain('COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED');
  });

  it('C2-REL-5 T8: an activation whose first period would strand usage recorded under the governed alignment stays held (USAGE_TREATMENT_UNDEFINED, CROSS_PERIOD); the governed row is untouched', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov));
    await applyAs(cr);
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    // A send at T0+30 min charged to the governed period (period_start = T0); the provider period starts at 00:00.
    await pg.query(
      `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_at, reserved_until, finalized_at) VALUES (gen_random_uuid(), $1, 'sign.envelopes', 'c2-env-1', $2, 'CONSUMED', $3, $3, $3)`,
      [t, T0, new Date(T0.getTime() + 30 * 60_000)],
    );
    const s = h.billing.state(t, intent, { current_period_start: new Date('2026-10-25T00:00:00.000Z') });
    const r = await deliver(s.subscription_ref, new Date(T0.getTime() + H));
    expect(r).toMatchObject({ outcome: 'IGNORED' });
    expect((r as { detail: string }).detail).toContain('USAGE_TREATMENT_UNDEFINED (CROSS_PERIOD');
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await releaseOf(cr)).toMatchObject({ state: 'CONSUMED' });
    expect((await sub(gov)).ended_at).toBeNull();
  });

  // ---- self-service → governed (C-13) -----------------------------------------------------

  it('C2-GOV-1 self-service → governed: apply enqueues the durable cancel and COMMITS IN APPLYING (pending-provider); the provider accepting it is not completion; the verified end opens the governed row in the applying transaction; replays and a late older event change nothing', async () => {
    now = T0;
    const { t, ss, ref } = await selfServiceTenant();
    const ssBefore = await sub(ss);
    const cr = await conversion(t, await toGoverned(ss));
    const a = await applyAs(cr);
    expect(a).toMatchObject({ replayed: false, direction: 'TO_GOVERNED', status: 'PENDING_PROVIDER', pending_provider: true, request: { state: 'APPLYING', apply_attempts: 1 }, application: null });
    expect(a.commands).toHaveLength(1);
    expect(a.commands[0]).toMatchObject({ command_kind: 'SUBSCRIPTION_CANCEL', step: 'end_self_service', target_ref: ref, params: { mode: 'IMMEDIATE' }, state: 'PENDING', idempotency_key: `aramo-ccp-${cr}-end_self_service` });
    expect(await openRows(t)).toEqual(['SELF_SERVICE']); // nothing local implies the provider changed
    expect(await applyAs(cr)).toMatchObject({ replayed: true, status: 'PENDING_PROVIDER' });

    const tally = await h.commands.dispatchDue(now);
    expect(tally.accepted).toBeGreaterThanOrEqual(1);
    expect((await commandsOf(cr))[0].state).toBe('PENDING_PROVIDER');
    expect((await reqRow(cr)).state).toBe('APPLYING');
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    expect((await h.conversions.view(cr)).pending_provider).toBe(true);

    now = new Date(T0.getTime() + H);
    const evt = evtId();
    const r = await deliver(ref, now, evt);
    expect(r).toMatchObject({ outcome: 'APPLIED' });
    expect((r as { detail: string }).detail).toContain(`conversion ${cr} APPLIED`);
    const ended = await sub(ss);
    expect(ended.ended_at).not.toBeNull();
    expect(ended.status).toBe('CANCELED');
    expect((await commandsOf(cr))[0]).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'WEBHOOK', confirmation_event_id: evt });
    const req = await reqRow(cr);
    expect(req.state).toBe('APPLIED');
    const app = await one(`SELECT * FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [cr]);
    expect(app).toMatchObject({ action_type: 'CONVERSION', replaced_subscription_id: ss, from_plan_version_id: ssBefore.plan_version_id, to_plan_version_id: await publishedVersion(pg, GOV_PLAN), attempt: 1 });
    const gov = await sub(app.subscription_id);
    expect(gov).toMatchObject({ source: 'MANUAL', ended_at: null, billing_subscription_ref: null });
    expect(gov.period_anchor.getTime()).toBe(ssBefore.period_anchor.getTime()); // T8: same period kept
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect(await entitlements(t)).toEqual(['core', 'sign']);
    expect(await auditTypes(cr)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_CONVERSION_PENDING_PROVIDER',
      'COMMERCIAL_SUBSCRIPTION_OPENED',
      'COMMERCIAL_ENTITLEMENT_GRANTED',
      'COMMERCIAL_CONVERSION_COMPLETED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    expect((await h.conversions.view(cr)).status).toBe('COMPLETED');
    // Replays / late events never erase the governed row (TD-C1-4 verification, C2-TDC14-3).
    const govJson = await rowJson(app.subscription_id);
    expect(await deliver(ref, now, evt)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await deliver(ref, new Date(T0.getTime() - H))).toMatchObject({ outcome: 'IGNORED', detail: 'subscription already ended' });
    expect(await rowJson(app.subscription_id)).toBe(govJson);
    expect(await applyAs(cr)).toMatchObject({ replayed: true, status: 'COMPLETED' });
  });

  it('C2-GOV-2 every completion check that can be taken before the provider call is taken first: a commitment term (DR-C2-1), a downgrade (T8) and a non-self-service target fail with 0 provider commands and 0 provider calls', async () => {
    now = T0;
    const calls = h.billing.calls.length;
    const a = await selfServiceTenant();
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_end = $2 WHERE id = $1`, [a.ss, new Date(T0.getTime() + 300 * 24 * H)]);
    const ca = await conversion(a.t, await toGoverned(a.ss));
    expect(await refusal(applyAs(ca))).toBe('FAILED:FINANCIAL_TREATMENT_UNDEFINED');
    const b = await selfServiceTenant();
    const cb = await conversion(b.t, { ...(await toGoverned(b.ss)), plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) });
    expect(await refusal(applyAs(cb))).toBe('FAILED:USAGE_TREATMENT_UNDEFINED');
    const c = await governedTenant();
    const cc = await conversion(c.t, await toGoverned(c.gov));
    expect(await refusal(applyAs(cc))).toBe('FAILED:TARGET_NOT_SELF_SERVICE');
    for (const cr of [ca, cb, cc]) {
      expect((await reqRow(cr)).state).toBe('APPLY_FAILED');
      expect(await commandsOf(cr)).toHaveLength(0);
    }
    expect(h.billing.calls.length).toBe(calls);
    expect(await openRows(a.t)).toEqual(['SELF_SERVICE']);
    expect(await openRows(b.t)).toEqual(['SELF_SERVICE']);
  });

  it('C2-GOV-3 a completion re-check that fails after the provider-confirmed end records APPLY_FAILED in the applying transaction (never APPLIED early, no governed row); the requester retry completes it once the condition clears', async () => {
    now = T0;
    const { t, ss, ref } = await selfServiceTenant();
    const cr = await conversion(t, await toGoverned(ss));
    await applyAs(cr);
    await h.commands.dispatchDue(now);
    // A send reserved between the apply and the provider end (T8 OPEN_RESERVATIONS).
    await pg.query(`INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_until) VALUES (gen_random_uuid(), $1, 'sign.envelopes', 'c2-res-1', '2026-10-01T00:00:00Z', 'RESERVED', now() + interval '1 hour')`, [t]);
    const r = await deliver(ref);
    expect((r as { detail: string }).detail).toContain(`conversion ${cr} APPLY_FAILED`);
    expect((await sub(ss)).ended_at).not.toBeNull();
    expect((await commandsOf(cr))[0].state).toBe('CONFIRMED');
    expect((await reqRow(cr)).state).toBe('APPLY_FAILED');
    expect(await openRows(t)).toEqual([]);
    expect(await one(`SELECT * FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [cr])).toBeUndefined();
    expect((await h.conversions.view(cr)).status).toBe('APPLY_FAILED');
    // Another requester still may not retry; the requester can, once the reservation settles.
    expect(await refusal(applyAs(cr, OPS2))).toBe('NOT_REQUESTER');
    await pg.query(`UPDATE subscription."AllowanceUsage" SET state = 'RELEASED', finalized_at = now() WHERE tenant_id = $1 AND send_key = 'c2-res-1'`, [t]);
    const retry = await applyAs(cr);
    expect(retry).toMatchObject({ status: 'COMPLETED', request: { state: 'APPLIED', apply_attempts: 2 }, application: { attempt: 2, replaced_subscription_id: ss } });
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect(h.billing.count('cancelSubscription', ref)).toBe(1); // the provider was asked exactly once
  });

  // ---- PBD §7.2 / C-29: held activation resolved through C2 ----------------------------------

  it('C2-C8-1 (C-9, C-11, C-12) a HELD activation is resolved governed → self-service: the release adopts the held provider subscription, the re-fetch after commit converts it in one transaction, the flag resolves; the held evidence is kept', async () => {
    now = T0;
    const { t, gov, intent, ref } = await heldTenant();
    const heldEvents = (await pg.query(`SELECT outcome, detail FROM subscription."BillingEvent" WHERE tenant_id = $1 ORDER BY received_at`, [t])).rows;
    const cr = await conversion(t, await toSelfService(gov, { held: ref }));
    const out = await applyAs(cr);
    expect(out).toMatchObject({ status: 'CONVERTED', request: { state: 'APPLIED' }, release: { state: 'CONVERTED', held_subscription_ref: ref, intent_id: intent } });
    expect((await sub(gov)).ended_at).not.toBeNull();
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    expect((await sub(out.release?.self_service_subscription_id as string)).billing_subscription_ref).toBe(ref);
    expect(await openFlags(t)).toEqual([]);
    expect((await one(`SELECT count(*)::int n FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND reason = 'governed_subscription_open' AND resolved_at IS NOT NULL`, [t])).n).toBe(1);
    expect(await intentStatus(intent)).toBe('COMPLETED');
    // C-14: the held BillingEvent (IGNORED, hold named) is never rewritten.
    expect((await pg.query(`SELECT outcome, detail FROM subscription."BillingEvent" WHERE tenant_id = $1 ORDER BY received_at`, [t])).rows.slice(0, heldEvents.length)).toEqual(heldEvents);
    expect(await auditTypes(cr)).toContain('COMMERCIAL_CONVERSION_COMPLETED');
  });

  it('C2-C8-2 (C-9, C-11, C-13) a HELD activation is resolved self-service → governed: a durable cancel of the held provider subscription; the flag stays open until the webhook-confirmed end resolves it; the governed row is byte-identical; the request completes', async () => {
    now = T0;
    const { t, gov, ref } = await heldTenant();
    const govBefore = await rowJson(gov);
    const cr = await conversion(t, { direction: 'TO_GOVERNED', held_subscription_ref: ref, governed_subscription_id: gov });
    const a = await applyAs(cr);
    expect(a).toMatchObject({ status: 'PENDING_PROVIDER', pending_provider: true, request: { state: 'APPLYING' } });
    expect(a.commands[0]).toMatchObject({ step: 'cancel_held_activation', target_ref: ref, params: { mode: 'IMMEDIATE' } });
    await h.commands.dispatchDue(now);
    expect(await openFlags(t)).toEqual(['governed_subscription_open']); // local commit is not provider confirmation
    const evt = evtId();
    expect(await deliver(ref, now, evt)).toMatchObject({ outcome: 'IGNORED' });
    expect(await openFlags(t)).toEqual([]);
    expect((await commandsOf(cr))[0]).toMatchObject({ state: 'CONFIRMED', confirmation_event_id: evt });
    expect(await reqRow(cr)).toMatchObject({ state: 'APPLIED' });
    expect(await rowJson(gov)).toBe(govBefore);
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND source = 'SELF_SERVICE'`, [t])).rows[0].n).toBe(0);
    expect((await h.conversions.view(cr)).status).toBe('COMPLETED');
  });

  it('C2-C8-3 (C-12 fallback) a held-activation release that expires before any provider re-fetch can apply it leaves the activation held: the release becomes EXPIRED, the flag stays open, the governed row is untouched', async () => {
    now = T0;
    const { t, gov, ref } = await heldTenant();
    const govBefore = await rowJson(gov);
    const state = h.billing.subs.get(ref);
    h.billing.subs.delete(ref); // the post-commit re-fetch fails (provider unavailable)
    const cr = await conversion(t, await toSelfService(gov, { held: ref, expires: new Date(T0.getTime() + H) }));
    const out = await applyAs(cr);
    expect(out).toMatchObject({ status: 'RELEASED', release: { state: 'RELEASED' } });
    h.billing.subs.set(ref, state as NonNullable<typeof state>);
    now = new Date(T0.getTime() + 2 * H);
    const r = await deliver(ref);
    expect(r).toMatchObject({ outcome: 'IGNORED' });
    expect((r as { detail: string }).detail).toContain('expired');
    expect(await releaseOf(cr)).toMatchObject({ state: 'EXPIRED' });
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await rowJson(gov)).toBe(govBefore);
  });

  // ---- Architect verification of TD-C1-4 (2026-10-25) ---------------------------------------

  it('C2-TDC14-1 checkout expiry comes only from authoritative provider evidence: no local timer expires a consumed checkout; an "expired" event whose re-fetch shows the session open changes nothing; the verified expired session (event or re-fetch) moves the intent to EXPIRED', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov, { expires: new Date(T0.getTime() + H) }));
    await applyAs(cr);
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    const session = h.billing.session(t, intent);
    // 30 days later, past the release expiry: the sweep and reads leave the consumed checkout alone.
    now = new Date(T0.getTime() + 30 * 24 * H);
    await h.conversions.expireReleases();
    expect(await intentStatus(intent)).toBe('CREATED');
    expect(await releaseOf(cr)).toMatchObject({ state: 'CONSUMED' });
    expect((await h.conversions.view(cr)).status).toBe('CHECKOUT_STARTED');
    // A claimed expiry the provider does not confirm: re-fetch says open → nothing changes.
    expect(await sessionEvent(session.session_ref)).toMatchObject({ outcome: 'IGNORED', detail: 'checkout session open' });
    expect(await intentStatus(intent)).toBe('CREATED');
    // Provider-confirmed (re-fetch path, no webhook): EXPIRED.
    h.billing.sessions.set(session.session_ref, { ...session, status: 'expired' });
    expect(await h.lifecycle.syncCheckoutSession(session.session_ref, 'sign', now)).toMatchObject({ outcome: 'APPLIED', detail: 'checkout session expired; intent EXPIRED' });
    expect(await intentStatus(intent)).toBe('EXPIRED');
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect((await sub(gov)).ended_at).toBeNull();
  });

  it('C2-TDC14-2 event replay is idempotent: the same expired-session event and the same activation event delivered again are DUPLICATE and write nothing', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov));
    await applyAs(cr);
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    const session = h.billing.session(t, intent, 'expired');
    const e1 = evtId();
    expect(await sessionEvent(session.session_ref, now, e1)).toMatchObject({ outcome: 'APPLIED' });
    const snap = async () => [await intentStatus(intent), JSON.stringify(await releaseOf(cr)), (await one(`SELECT count(*)::int n FROM subscription."BillingEvent" WHERE tenant_id = $1`, [t])).n];
    const before = await snap();
    expect(await sessionEvent(session.session_ref, now, e1)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await snap()).toEqual(before);
    // An activation event for the held tenant, delivered twice.
    const s = h.billing.state(t, await rawIntent(t));
    const e2 = evtId();
    expect(await deliver(s.subscription_ref, now, e2)).toMatchObject({ outcome: 'IGNORED' });
    const flags = await openFlags(t);
    expect(await deliver(s.subscription_ref, now, e2)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await openFlags(t)).toEqual(flags);
  });

  it('C2-TDC14-3 late or out-of-order webhooks never activate or erase a governed subscription: an activation after the release expired is held; an activation for an EXPIRED checkout is held; an older event after a conversion completes is ignored', async () => {
    now = T0;
    // (a) The released checkout's activation arrives after its session was confirmed expired.
    const a = await governedTenant();
    const ca = await conversion(a.t, await toSelfService(a.gov));
    await applyAs(ca);
    expect(await refusal(checkout(a.t))).toBe('OK');
    const ia = await lastIntent(a.t);
    expect(await sessionEvent(h.billing.session(a.t, ia, 'expired').session_ref)).toMatchObject({ outcome: 'APPLIED' });
    const govA = await rowJson(a.gov);
    const late = h.billing.state(a.t, ia);
    const r = await deliver(late.subscription_ref);
    expect(r).toMatchObject({ outcome: 'IGNORED' });
    expect((r as { detail: string }).detail).toContain('the checkout is EXPIRED');
    expect(await rowJson(a.gov)).toBe(govA);
    expect(await openRows(a.t)).toEqual(['MANUAL']);
    expect(await releaseOf(ca)).toMatchObject({ state: 'CONSUMED' });
    // (b) An unconsumed held-activation release past expiry: a late activation re-sync stays held.
    const b = await heldTenant();
    const cb = await conversion(b.t, await toSelfService(b.gov, { held: b.ref, expires: new Date(now.getTime() + H) }));
    const keep = h.billing.subs.get(b.ref);
    h.billing.subs.delete(b.ref);
    await applyAs(cb);
    h.billing.subs.set(b.ref, keep as NonNullable<typeof keep>);
    const govB = await rowJson(b.gov);
    expect(await deliver(b.ref, new Date(now.getTime() + 3 * H))).toMatchObject({ outcome: 'IGNORED' });
    expect(await rowJson(b.gov)).toBe(govB);
    // (c) After a completed self-service → governed conversion, an older provider state of the ended
    // self-service subscription is ignored (C2-GOV-1 covers it in full).
  });

  it('C2-TDC14-4 an expired checkout never bypasses the protected MANUAL rule: the release it consumed is spent (no new checkout), the MANUAL row is never ended without a provider-confirmed paid subscription; a fresh release is refused while the old checkout is not provider-confirmed expired and allowed after', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const govBefore = await rowJson(gov);
    const c1 = await conversion(t, await toSelfService(gov));
    await applyAs(c1);
    expect(await refusal(checkout(t))).toBe('OK');
    const intent = await lastIntent(t);
    const session = h.billing.session(t, intent);
    expect(await refusal(checkout(t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    // A fresh release while the consumed checkout may still complete: refused (no local timer decides).
    const c2 = await conversion(t, await toSelfService(gov));
    expect(await refusal(applyAs(c2))).toBe('FAILED:RELEASE_CHECKOUT_OPEN');
    // The provider confirms the session expired.
    h.billing.sessions.set(session.session_ref, { ...session, status: 'expired' });
    expect(await sessionEvent(session.session_ref)).toMatchObject({ outcome: 'APPLIED' });
    expect(await rowJson(gov)).toBe(govBefore);
    expect(await refusal(checkout(t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    // Now a fresh request may release a new checkout (the retry of the failed one is admitted).
    const retry = await applyAs(c2);
    expect(retry).toMatchObject({ status: 'RELEASED', request: { state: 'APPLIED', apply_attempts: 2 } });
    expect(await rowJson(gov)).toBe(govBefore);
  });

  // ---- authority, NC-5, apply deadline ------------------------------------------------------

  it('C2-AUTH-1 apply is requester-only (TD-B2-3): another commercial_ops → NOT_REQUESTER; finance_admin → REQUESTER_SCOPE_MISSING; not approved → refused; another action → ACTION_NOT_APPLICABLE; NC-5 lost eligibility → refused with no state change; none writes a domain row', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov), OPS, FA2);
    expect(await refusal(applyAs(cr, OPS2))).toBe('NOT_REQUESTER');
    expect(await refusal(applyAs(cr, FA, 'finance_admin'))).toBe('REQUESTER_SCOPE_MISSING');
    expect(await refusal(h.conversions.apply(as(OPS, 'commercial_ops', { actor_kind: 'service' }), cr, A6_CTX))).toBe('NOT_HUMAN');
    await revokeRole(pg, FA2, 'finance_admin');
    expect(await refusal(applyAs(cr))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await reqRow(cr)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await releaseOf(cr)).toBeUndefined();
    expect(await auditTypes(cr)).toContain('COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED');
    await grantRole(pg, FA2, 'finance_admin');
    expect(await applyAs(cr)).toMatchObject({ status: 'RELEASED' });
    const t2 = await governedTenant();
    const draft = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t2.t, product_key: 'sign', payload: await toSelfService(t2.gov), reason: 'draft', idempotency_key: key() }, A6_CTX);
    expect(await refusal(applyAs(draft.request.id))).toBe('REFUSED:NOT_APPROVED');
    const end = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_END', tenant_id: (await newTenant(pg)), product_key: 'sign', payload: { subscription_id: randomUUID() }, reason: 'x', idempotency_key: key() }, A6_CTX);
    expect(await refusal(applyAs(end.request.id))).toBe('ACTION_NOT_APPLICABLE');
    // The A6 path does not apply a CONVERSION either.
    expect(await refusal(h.apply.apply(as(OPS, 'commercial_ops'), cr, A6_CTX))).toBe('ACTION_NOT_APPLICABLE');
  });

  it('C2-AUTH-2 the payload is a closed schema per direction, enforced at create (INVALID_INPUT)', async () => {
    const t = await newTenant(pg);
    const create = (payload: unknown) => refusal(h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload, reason: 'x', idempotency_key: key() }, A6_CTX));
    expect(await create({})).toBe('INVALID_INPUT');
    expect(await create({ direction: 'SIDEWAYS' })).toBe('INVALID_INPUT');
    expect(await create({ direction: 'TO_SELF_SERVICE', governed_subscription_id: randomUUID(), plan_key: BUSINESS, plan_version_id: randomUUID() })).toBe('INVALID_INPUT');
    expect(await create({ direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: GOV_PLAN, plan_version_id: randomUUID(), mode: 'AT_PERIOD_END' })).toBe('INVALID_INPUT');
    expect(await create({ direction: 'TO_GOVERNED', held_subscription_ref: 'sub_x', governed_subscription_id: randomUUID(), plan_key: GOV_PLAN })).toBe('INVALID_INPUT');
  });

  it('C2-AD-1 a request snapshotted under policy v1 (no apply-deadline key) has no apply deadline (AD-2): applied 100 h after approval', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov, { expires: new Date(T0.getTime() + 200 * H) }));
    now = new Date(T0.getTime() + 100 * H);
    expect(await applyAs(cr)).toMatchObject({ status: 'RELEASED' });
  });

  // ---- DB backstops, history, no provider call in a transaction -----------------------------

  it('C2-DB-1 DB guard and release trigger: CONVERSION cannot commit in APPLYING without a provider command, cannot be APPLY_FAILED while one is unconfirmed, cannot be APPLIED without its application; the release is append-only, immutable, consumed only before expiry, CONVERTED only with both rows, one live per tenant × product', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const cr = await conversion(t, await toSelfService(gov));
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, updated_at = now() WHERE id = $1`, [cr])).toContain('cannot commit in APPLYING without a provider command');
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now(), updated_at = now() WHERE id = $1`, [cr])).toContain('is not allowed');
    expect(await dbError(`BEGIN; UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, updated_at = now() WHERE id = '${cr}'; UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now(), updated_at = now() WHERE id = '${cr}'; COMMIT;`)).toContain('without its CommercialChangeApplication');
    await pg.query('ROLLBACK').catch(() => undefined);
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET apply_attempts = 5, updated_at = now() WHERE id = $1`, [cr])).toContain('change only with a state transition');
    // A pending-provider TO_GOVERNED request cannot be failed locally.
    const s = await selfServiceTenant();
    const g = await conversion(s.t, await toGoverned(s.ss));
    await applyAs(g);
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED', updated_at = now() WHERE id = $1`, [g])).toContain('cannot be APPLY_FAILED while a provider command is unconfirmed');
    // Release trigger.
    await applyAs(cr);
    const rel = await releaseOf(cr);
    expect(await dbError(`DELETE FROM subscription."CommercialConversionRelease" WHERE id = $1`, [rel.id])).toContain('never deleted');
    expect(await dbError(`UPDATE subscription."CommercialConversionRelease" SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [rel.id])).toContain('immutable');
    expect(await dbError(`UPDATE subscription."CommercialConversionRelease" SET state = 'CONVERTED', converted_at = now(), consumed_at = now(), self_service_subscription_id = $2, intent_id = gen_random_uuid() WHERE id = $1`, [rel.id, gov])).toMatch(/refused|still open|violates/);
    const intent = await rawIntent(t);
    expect(await dbError(`UPDATE subscription."CommercialConversionRelease" SET state = 'CONSUMED', intent_id = $2, consumed_at = expires_at WHERE id = $1`, [rel.id, intent])).toContain('CommercialConversionRelease_consumed_check');
    expect(await dbError(`UPDATE subscription."CommercialConversionRelease" SET state = 'EXPIRED', expired_at = now() WHERE id = $1`, [rel.id])).toContain('CommercialConversionRelease_expired_check');
    expect(
      await dbError(
        `INSERT INTO subscription."CommercialConversionRelease" (id, change_request_id, tenant_id, product_key, governed_subscription_id, plan_id, plan_version_id, state, expires_at, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), $1, tenant_id, product_key, governed_subscription_id, plan_id, plan_version_id, 'RELEASED', expires_at, created_by, created_at, updated_at FROM subscription."CommercialConversionRelease" WHERE id = $2`,
        [cr, rel.id],
      ),
    ).toContain('is not a CONVERSION being applied');
    expect(await dbError(`DELETE FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [cr])).toContain('append-only');
  });

  it('C2-HIST-1 history is never deleted or rewritten: across every conversion above, ended rows keep ended_at and are never reopened; BillingEvent, CheckoutIntent, LegalAcceptance, flags and audit rows only grow', async () => {
    const counts = async () =>
      (await pg.query(
        `SELECT (SELECT count(*) FROM subscription."BillingEvent")::int be, (SELECT count(*) FROM subscription."CheckoutIntent")::int ci, (SELECT count(*) FROM subscription."LegalAcceptance")::int la,
                (SELECT count(*) FROM subscription."BillingReconciliationFlag")::int fl, (SELECT count(*) FROM subscription."CommercialAuditEvent")::int au,
                (SELECT count(*) FROM subscription."TenantSubscription" WHERE ended_at IS NOT NULL)::int ended`,
      )).rows[0];
    const before = await counts();
    // One more full conversion in each direction.
    now = T0;
    const a = await governedTenant();
    const ca = await conversion(a.t, await toSelfService(a.gov));
    await applyAs(ca);
    await checkout(a.t);
    const ia = await lastIntent(a.t);
    await deliver(h.billing.state(a.t, ia, { current_period_start: now }).subscription_ref);
    const b = await selfServiceTenant();
    const cb = await conversion(b.t, await toGoverned(b.ss));
    await applyAs(cb);
    await h.commands.dispatchDue(now);
    await deliver(b.ref);
    const after = await counts();
    for (const k of ['be', 'ci', 'la', 'fl', 'au', 'ended'] as const) expect(after[k], k).toBeGreaterThanOrEqual(before[k]);
    expect(after.ended).toBe(before.ended + 2);
    // An ended row is never reopened by any later event.
    expect(await deliver(b.ref)).toMatchObject({ outcome: 'IGNORED', detail: 'subscription already ended' });
    expect(await dbError(`DELETE FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1`, [ca])).not.toBe('OK');
  });

  it('C2-TX-1 no provider call ran inside a local database transaction anywhere in this spec (the fake probe on every call)', () => {
    expect(h.billing.violations).toEqual([]);
    expect(h.billing.probes).toBeGreaterThan(20);
  });
});
