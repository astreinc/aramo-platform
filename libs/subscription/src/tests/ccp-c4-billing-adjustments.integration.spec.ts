import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingCommandError } from '../lib/billing/billing-command.service.js';
import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { BillingAdjustmentRefusedError, REFUND_EXECUTION_FLAG, discountCouponRef } from '../lib/commercial/commercial-billing-adjustment.js';
import { CommercialApprovalRefusedError, CommercialChangeRequestError, CommercialNotBootstrappedError } from '../lib/commercial/commercial-change-request.service.js';
import { ConversionApplyFailedError } from '../lib/commercial/commercial-conversion.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { CommercialRefundReportService } from '../lib/commercial/commercial-refund-report.service.js';
import { RefundRemainderRefusedError, refundBindingOf } from '../lib/commercial/refund-remainder.gate.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { CCP_BUNDLES, POLICY_V1, activatePolicyV2, addOperator, applyCcpA6Schema, grantRole, revokeRole } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C4Harness, c4Harness, refundPayload } from './support/ccp-c4.js';

// CCP-C4 (PBD §5.2 row C4, §10; Conversion Rule C-22, C-23; Charter §6.4 NC-1…NC-5, §7 D5) — credits,
// discounts and refunds executed in Stripe by C1 durable command, on real Postgres 17 with the real
// change-request, apply, command, lifecycle and inbox services; Stripe is a fake (no network, no
// key). Test IDs are cited by doc/ccp/slices/CCP-C4-acceptance.md:
//   C4-TH-*     threshold escalation from the ACTIVE policy (20% / $500, inclusive), NC-5 snapshot
//   C4-MONEY-*  no money movement before the chain completes (zero provider writes before apply)
//   C4-PEND-*   pending-provider until the confirming webhook (or re-fetch); APPLIED only then
//   C4-IDEM-*   idempotent apply, enqueue and dispatch (one effect per request)
//   C4-FAIL-*   failed commands visible; re-arm with the same key; pre-command failures
//   C4-REFUND-* the refund designed disabled state; the flag-on path (tests only)
//   C4-COMP-*   recovery: a compensating Stripe command through a new change request
//   C4-NC-*     NC-1…NC-5, self-approval and one person holding two roles, on the C4 action types
//   C4-AUTH-*, C4-DB-*, C4-TX-*

const T0 = new Date('2026-10-26T12:00:00.000Z');
const H = 3_600_000;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C4 credits, discounts and refunds (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let probe: Client;
  let prisma: PrismaService;
  let h: C4Harness;
  let OPS: string;
  let OPS2: string;
  let FA: string;
  let FA2: string;
  let PO: string;
  let PO2: string;
  let now = T0;
  let keyN = 0;
  let evtN = 0;
  const key = () => `c4-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_c4_${String(++evtN).padStart(6, '0')}`;
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
    delete process.env[REFUND_EXECUTION_FLAG];
    h = c4Harness(prisma, clock);
    h.billing.attachProbe(probe);
    OPS = await addOperator(pg, ['commercial_ops']);
    OPS2 = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    PO2 = await addOperator(pg, ['platform_owner']);
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
  const reqRow = (id: string) => one(`SELECT * FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id]);
  const commandsOf = async (cr: string) => (await pg.query(`SELECT * FROM subscription."BillingProviderCommand" WHERE change_request_id = $1 ORDER BY created_at`, [cr])).rows;
  const adjustmentOf = (cr: string) => one(`SELECT * FROM subscription."CommercialBillingAdjustment" WHERE change_request_id = $1`, [cr]);
  const auditTypes = async (cr: string) => (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [cr])).rows.map((r) => r.event_type as string);
  const approvalsJson = async (cr: string) => (await pg.query(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1 ORDER BY step_index`, [cr])).rows.map((r) => r.j as string);
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
      if (e instanceof BillingAdjustmentRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialApprovalRefusedError) return `APPROVAL:${e.refusal}`;
      if (e instanceof CommercialNotBootstrappedError) return 'NOT_BOOTSTRAPPED';
      if (e instanceof CommercialChangeRequestError) return e.code === 'REFUND_NOT_REFUNDABLE' ? `NOT_REFUNDABLE:${String(e.details['refusal'])}` : e.code;
      if (e instanceof BillingCommandError) return `COMMAND:${e.code}`;
      if (e instanceof ConversionApplyFailedError) return `CONVERSION_FAILED:${e.code}`;
      throw e;
    }
  }

  /** A tenant with an open Stripe-owned SELF_SERVICE row (provider account acct_<t>, subscription sub_<x>). */
  async function selfServiceTenant(): Promise<{ t: string; ss: string; ref: string; acct: string }> {
    const t = await newTenant(pg);
    const s = h.billing.state(t, randomUUID());
    const ss = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    return { t, ss, ref: s.subscription_ref, acct: `acct_${t}` };
  }
  const create = (action: 'CREDIT' | 'DISCOUNT' | 'REFUND', t: string, payload: Record<string, unknown>, requester = OPS) =>
    h.changeRequests.create(as(requester, 'commercial_ops'), { action_type: action, tenant_id: t, product_key: 'sign', payload, reason: `c4 ${action.toLowerCase()}`, idempotency_key: key() }, A6_CTX);
  const submit = (id: string, requester = OPS) => h.changeRequests.submit(as(requester, 'commercial_ops'), id, A6_CTX);
  const approveFa = (id: string, user = FA) => h.changeRequests.approve(as(user, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
  const approvePo = (id: string, user = PO) => h.changeRequests.approve(as(user, 'platform_owner'), id, { step_index: 1 }, A6_CTX);
  /** Created, submitted and approved through its WHOLE snapshotted chain (Finance; and Owner when escalated). */
  async function approved(action: 'CREDIT' | 'DISCOUNT' | 'REFUND', t: string, payload: Record<string, unknown>, requester = OPS): Promise<string> {
    const r = await create(action, t, payload, requester);
    await submit(r.request.id, requester);
    const a = await approveFa(r.request.id);
    if (a.request.state !== 'APPROVED') await approvePo(r.request.id);
    expect((await reqRow(r.request.id)).state).toBe('APPROVED');
    return r.request.id;
  }
  const applyAs = (id: string, user = OPS, role = 'commercial_ops') => h.adjustments.apply(as(user, role), id, A6_CTX);
  const dispatch = () => h.commands.dispatchDue(now);
  const deliverObject = (object_ref: string, type = 'balance_transaction.created', id: string = evtId()) => h.inbox.receive({ id, type, created: now, subscription_ref: null, object_ref }, 'sign', now);
  const chainRule = async (id: string) => ((await reqRow(id)).required_chain as { rule: string }).rule;

  // ---- threshold escalation (PBD C4 row "thresholds from the active policy (20% / $500)") -----

  it('C4-TH-1 credit: the chain is read from the ACTIVE policy at creation — 49 999 minor units → Finance only (one signature approves); 50 000 (the exact $500 value, inclusive) → Finance → Owner (Finance alone leaves it pending); a non-policy currency escalates', async () => {
    const { t } = await selfServiceTenant();
    const below = await create('CREDIT', t, { amount_minor: 49_999, currency: 'USD' });
    expect(await chainRule(below.request.id)).toBe('FINANCE_ONLY');
    expect((below.request.required_chain as { basis: Record<string, unknown> }).basis).toMatchObject({ credit_escalation_threshold_minor: 50_000, escalates: false });
    await submit(below.request.id);
    expect((await approveFa(below.request.id)).request.state).toBe('APPROVED');

    const t2 = (await selfServiceTenant()).t;
    const at = await create('CREDIT', t2, { amount_minor: 50_000, currency: 'USD' });
    expect(await chainRule(at.request.id)).toBe('FINANCE_THEN_OWNER');
    await submit(at.request.id);
    expect((await approveFa(at.request.id)).request.state).toBe('PENDING_APPROVAL');
    expect((await approvePo(at.request.id)).request.state).toBe('APPROVED');

    const t3 = (await selfServiceTenant()).t;
    const eur = await create('CREDIT', t3, { amount_minor: 1, currency: 'EUR' });
    expect(eur.request.required_chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', basis: { escalates: true, escalation_reason: 'CURRENCY_NOT_COVERED' } });
  });

  it('C4-TH-2 discount: 1 999 bps (19.99%) → Finance only; 2 000 bps (the exact 20% value, inclusive) → Finance → Owner; refund: Finance → Owner for any amount (no policy threshold exists; none is invented, TD-C4-2)', async () => {
    const a = await create('DISCOUNT', (await selfServiceTenant()).t, { discount_bps: 1_999 });
    expect(await chainRule(a.request.id)).toBe('FINANCE_ONLY');
    const b = await create('DISCOUNT', (await selfServiceTenant()).t, { discount_bps: 2_000 });
    expect(b.request.required_chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', basis: { discount_bps: 2_000, discount_escalation_threshold_bps: 2_000, escalates: true } });
    const small = await selfServiceTenant();
    h.billing.invoices.set('in_c4small', { account_ref: small.acct });
    const r = await create('REFUND', small.t, refundPayload(1, 'in_c4small'));
    expect(r.request.required_chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', steps: [{ role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] }, { role_key: 'platform_owner', scope_keys: ['platform:billing:approve'] }] });
    expect(r.request.policy_version_id).toBe(POLICY_V1);
  });

  // ---- no money movement before the chain completes (PBD C4 HALT row) ------------------------

  it('C4-MONEY-1 zero provider calls at every state before the apply: DRAFT, PENDING_APPROVAL, one of two steps signed, REJECTED, and APPROVED-but-not-applied (the dispatcher runs at each point); the enqueue gate refuses a command before the chain completes, in the service and at the database', async () => {
    const { t, ss, acct } = await selfServiceTenant();
    const before = h.billing.adjustmentCalls.length;
    const writes0 = h.billing.writes;
    const r = await create('CREDIT', t, { amount_minor: 60_000, currency: 'USD' });
    const id = r.request.id;
    const enqueue = () => h.commands.enqueue({ change_request_id: id, step: 'credit_grant', command_kind: 'CREDIT_GRANT', tenant_id: t, product_key: 'sign', target_ref: acct, params: { subscription_id: ss, amount_minor: 60_000, currency: 'USD' }, created_by: OPS, at: now });
    const rawInsert = () =>
      dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES ($1, 'STRIPE', 'CREDIT_GRANT', $2::uuid, 'credit_grant', 'aramo-ccp-' || $2::text || '-credit_grant', $3, 'sign', $4, $5::jsonb, 'PENDING', 0, $6, now(), now())`,
        [randomUUID(), id, t, acct, JSON.stringify({ subscription_id: ss, amount_minor: 60_000, currency: 'USD' }), OPS],
      );
    // DRAFT
    expect(await refusal(enqueue())).toBe('COMMAND:CHANGE_REQUEST_NOT_APPROVED');
    expect(await rawInsert()).toContain('needs a completed approval chain');
    await dispatch();
    // PENDING_APPROVAL
    await submit(id);
    expect(await refusal(enqueue())).toBe('COMMAND:CHANGE_REQUEST_NOT_APPROVED');
    expect(await rawInsert()).toContain('needs a completed approval chain');
    expect(await refusal(applyAs(id))).toBe('REFUSED:NOT_APPROVED');
    await dispatch();
    // One of two steps signed (Finance → Owner)
    expect((await approveFa(id)).request.state).toBe('PENDING_APPROVAL');
    expect(await refusal(enqueue())).toBe('COMMAND:CHANGE_REQUEST_NOT_APPROVED');
    expect(await refusal(applyAs(id))).toBe('REFUSED:NOT_APPROVED');
    await dispatch();
    expect(await commandsOf(id)).toEqual([]);
    // REJECTED
    await h.changeRequests.reject(as(PO, 'platform_owner'), id, { reason: 'no' }, A6_CTX);
    expect(await refusal(applyAs(id))).toBe('REFUSED:NOT_APPROVED');
    expect(await rawInsert()).toContain('needs a completed approval chain');
    await dispatch();
    // APPROVED, not yet applied by its requester
    const ok = await approved('CREDIT', (await selfServiceTenant()).t, { amount_minor: 100, currency: 'USD' });
    await dispatch();
    expect(await commandsOf(ok)).toEqual([]);
    expect(h.billing.adjustmentCalls.length - before).toBe(0);
    expect(h.billing.writes - writes0).toBe(0);
  });

  // ---- pending until webhook (C-22, C-23) -----------------------------------------------------

  it('C4-PEND-1 credit: the requester\'s apply commits APPLYING with ONE command and no provider call; the dispatcher writes once (no transaction open); the request stays APPLYING (pending-provider) until the verified webhook naming the object arrives through the inbox, which confirms the command, records the adjustment and APPLIES the request in one transaction; a redelivery is DUPLICATE', async () => {
    const { t, ss, acct } = await selfServiceTenant();
    const id = await approved('CREDIT', t, { amount_minor: 35_000, currency: 'USD', subscription_id: ss });
    const writes0 = h.billing.writes;
    const out = await applyAs(id);
    expect(out).toMatchObject({ replayed: false, operation: 'CREDIT_GRANT', status: 'PENDING_PROVIDER', pending_provider: true, adjustment: null, request: { state: 'APPLYING', apply_attempts: 1 } });
    expect(out.commands).toHaveLength(1);
    expect(out.commands[0]).toMatchObject({ command_kind: 'CREDIT_GRANT', state: 'PENDING', step: 'credit_grant', idempotency_key: `aramo-ccp-${id}-credit_grant`, target_ref: acct, params: { subscription_id: ss, amount_minor: 35_000, currency: 'USD' } });
    expect(h.billing.writes - writes0).toBe(0); // the apply itself never calls the provider
    expect((await reqRow(id)).state).toBe('APPLYING'); // committed in APPLYING (pending-provider)

    const tally = await dispatch();
    expect(tally).toMatchObject({ skipped: null });
    expect(h.billing.writes - writes0).toBe(1);
    const [c] = await commandsOf(id);
    expect(c).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 1, confirmed_at: null });
    expect(c.provider_object_ref).toMatch(/^cbtxn_c4_/);
    expect(h.billing.balance.filter((b) => b.command_id === c.id)).toEqual([{ id: c.provider_object_ref, account_ref: acct, amount: -35_000, currency: 'usd', command_id: c.id, tenant_id: t }]);
    // Still pending: the provider accepted it, Aramo has not seen the confirming effect applied.
    expect((await reqRow(id)).state).toBe('APPLYING');
    expect((await h.adjustments.view(id))).toMatchObject({ status: 'PENDING_PROVIDER', pending_provider: true, adjustment: null });
    expect(await dispatch()).toMatchObject({ claimed: 0 }); // nothing more to send
    expect(h.billing.writes - writes0).toBe(1);

    // A webhook about an unrelated object changes nothing.
    expect(await deliverObject('cbtxn_unrelated')).toMatchObject({ outcome: 'IGNORED' });
    expect((await reqRow(id)).state).toBe('APPLYING');

    const evt = evtId();
    const res = await deliverObject(c.provider_object_ref, 'balance_transaction.created', evt);
    expect(res).toMatchObject({ outcome: 'APPLIED' });
    const r = await reqRow(id);
    expect(r).toMatchObject({ state: 'APPLIED' });
    expect(r.applied_at).not.toBeNull();
    const [c2] = await commandsOf(id);
    expect(c2).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'WEBHOOK', confirmation_event_id: evt });
    expect(await adjustmentOf(id)).toMatchObject({ action_type: 'CREDIT', operation: 'CREDIT_GRANT', tenant_id: t, subscription_id: ss, provider_target_ref: acct, provider_object_ref: c.provider_object_ref, currency: 'USD', command_id: c.id, confirmation_source: 'WEBHOOK', confirmation_event_id: evt, attempt: 1, requested_by: OPS });
    expect(Number((await adjustmentOf(id)).amount_minor)).toBe(35_000);
    expect(await auditTypes(id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_BILLING_ADJUSTMENT_PENDING_PROVIDER',
      'COMMERCIAL_BILLING_ADJUSTMENT_CONFIRMED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    // C4 audit bodies carry no amount (Finance amount interim).
    const bodies = (await pg.query(`SELECT payload::text p FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type LIKE 'COMMERCIAL_BILLING_ADJUSTMENT_%'`, [id])).rows.map((x) => x.p as string);
    for (const b of bodies) expect(b).not.toContain('35000');
    expect(await deliverObject(c.provider_object_ref, 'balance_transaction.created', evt)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await applyAs(id)).toMatchObject({ replayed: true, status: 'APPLIED' });
    expect(h.billing.writes - writes0).toBe(1);
    expect(h.billing.violations).toEqual([]);
  });

  it('C4-PEND-2 without a webhook the request stays APPLYING; the provider re-fetch (reconcilePending) confirms it with source REFETCH', async () => {
    const { t } = await selfServiceTenant();
    const id = await approved('CREDIT', t, { amount_minor: 1_000, currency: 'USD' });
    await applyAs(id);
    await dispatch();
    expect((await reqRow(id)).state).toBe('APPLYING');
    const rec = await h.commands.reconcilePending('sign', now);
    expect(rec.confirmed).toBeGreaterThanOrEqual(1);
    expect((await reqRow(id)).state).toBe('APPLIED');
    expect((await commandsOf(id))[0]).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'REFETCH', confirmation_event_id: null });
    expect(await adjustmentOf(id)).toMatchObject({ confirmation_source: 'REFETCH' });
  });

  it('C4-PEND-3 discount: a percent-off coupon with the deterministic id is attached (next invoice only); a verified subscription event for the subscription re-reads it and applies the request', async () => {
    const { t, ref } = await selfServiceTenant();
    const id = await approved('DISCOUNT', t, { discount_bps: 1_500 });
    const out = await applyAs(id);
    expect(out.commands[0]).toMatchObject({ command_kind: 'DISCOUNT_APPLY', step: 'discount_apply', target_ref: ref, params: { discount_bps: 1_500, coupon_ref: discountCouponRef(id) } });
    await dispatch();
    expect(h.billing.discounts.get(ref)).toMatchObject({ coupon_ref: discountCouponRef(id) });
    expect((await reqRow(id)).state).toBe('APPLYING');
    const res = await h.inbox.receive({ id: evtId(), type: 'subscription.updated', created: now, subscription_ref: ref }, 'sign', now);
    expect(res).toMatchObject({ outcome: 'APPLIED' });
    expect((await reqRow(id)).state).toBe('APPLIED');
    expect(await adjustmentOf(id)).toMatchObject({ action_type: 'DISCOUNT', operation: 'DISCOUNT_APPLY', discount_bps: 1_500, amount_minor: null, confirmation_source: 'WEBHOOK' });
  });

  // ---- idempotency --------------------------------------------------------------------------

  it('C4-IDEM-1 one effect per request: a second apply is replayed (no second command); an enqueue replay returns the same command and a different command on the step is refused; a transient failure retries with the SAME key; a lost provider response is not repeated (the pre-dispatch re-read finds the effect)', async () => {
    const { t, ss, acct } = await selfServiceTenant();
    const id = await approved('CREDIT', t, { amount_minor: 2_000, currency: 'USD' });
    await applyAs(id);
    expect(await applyAs(id)).toMatchObject({ replayed: true, status: 'PENDING_PROVIDER' });
    const [c] = await commandsOf(id);
    expect(await commandsOf(id)).toHaveLength(1);
    const again = await h.commands.enqueue({ change_request_id: id, step: 'credit_grant', command_kind: 'CREDIT_GRANT', tenant_id: t, product_key: 'sign', target_ref: acct, params: { subscription_id: ss, amount_minor: 2_000, currency: 'USD' }, created_by: OPS, at: now });
    expect(again).toMatchObject({ replayed: true, command: { id: c.id } });
    expect(await refusal(h.commands.enqueue({ change_request_id: id, step: 'credit_grant', command_kind: 'CREDIT_GRANT', tenant_id: t, product_key: 'sign', target_ref: acct, params: { subscription_id: ss, amount_minor: 2_001, currency: 'USD' }, created_by: OPS, at: now }))).toBe('COMMAND:IDEMPOTENCY_CONFLICT');
    // transient twice, then the response is lost once, then accepted
    h.billing.adjustmentFailures.set(c.id, { kind: 'transient', times: 2 });
    h.billing.lostResponses.set(c.id, 1);
    const at0 = now;
    for (let i = 0; i < 4; i += 1) {
      await dispatch();
      now = new Date(now.getTime() + 10 * 60_000);
    }
    now = at0;
    const keys = h.billing.adjustmentCalls.filter((x) => x.op === 'executeAdjustment' && x.command_id === c.id).map((x) => x.idempotency_key);
    expect(keys).toEqual([c.idempotency_key, c.idempotency_key, c.idempotency_key]); // 2 transient + the lost one; the 4th dispatch re-read and did NOT write
    expect(h.billing.balance.filter((b) => b.command_id === c.id)).toHaveLength(1);
    const [c2] = await commandsOf(id);
    expect(c2).toMatchObject({ state: 'PENDING_PROVIDER', last_error_detail: 'already in effect at the provider' });
    expect(c2.provider_object_ref).toBe(h.billing.balance.find((b) => b.command_id === c.id)?.id);
    await deliverObject(c2.provider_object_ref);
    expect((await reqRow(id)).state).toBe('APPLIED');
    expect(h.billing.balance.filter((b) => b.command_id === c.id)).toHaveLength(1);
  });

  // ---- failures ------------------------------------------------------------------------------

  it('C4-FAIL-1 a provider refusal FAILS the command (visible; never dropped) and keeps the request APPLYING (status COMMAND_FAILED, never reported applied); the requester\'s next apply RE-ARMS the same command with the same key; it is then accepted and confirmed', async () => {
    const { t } = await selfServiceTenant();
    const id = await approved('CREDIT', t, { amount_minor: 3_000, currency: 'USD' });
    await applyAs(id);
    const [c] = await commandsOf(id);
    h.billing.adjustmentFailures.set(c.id, { kind: 'refused', times: 1 });
    await dispatch();
    expect((await commandsOf(id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'PROVIDER_REFUSED' });
    expect(await h.adjustments.view(id)).toMatchObject({ status: 'COMMAND_FAILED', pending_provider: true, request: { state: 'APPLYING' } });
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toContain('cannot be APPLY_FAILED while a provider command is unconfirmed');
    expect(await refusal(applyAs(id, OPS2))).toBe('NOT_REQUESTER');
    const re = await applyAs(id);
    expect(re).toMatchObject({ replayed: false, status: 'PENDING_PROVIDER' });
    const rearmed = await commandsOf(id);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]).toMatchObject({ id: c.id, state: 'PENDING', idempotency_key: c.idempotency_key, attempts: 1 });
    expect(await auditTypes(id)).toContain('COMMERCIAL_BILLING_ADJUSTMENT_REARMED');
    await dispatch();
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(id)).state).toBe('APPLIED');
    expect(h.billing.balance.filter((b) => b.command_id === c.id)).toHaveLength(1);
  });

  it('C4-FAIL-2 a governed (MANUAL) tenant is never a C4 target: the apply fails TARGET_NOT_SELF_SERVICE (rolled back; APPLY_FAILED, retryable), with no command and no provider call; a stale named subscription fails TARGET_STALE', async () => {
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'MANUAL' });
    const w = h.billing.writes;
    const id = await approved('CREDIT', t, { amount_minor: 100, currency: 'USD' });
    expect(await refusal(applyAs(id))).toBe('FAILED:TARGET_NOT_SELF_SERVICE');
    expect(await reqRow(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1 });
    expect(await commandsOf(id)).toEqual([]);
    const s2 = await selfServiceTenant();
    const stale = await approved('DISCOUNT', s2.t, { discount_bps: 500, subscription_id: randomUUID() });
    expect(await refusal(applyAs(stale))).toBe('FAILED:TARGET_STALE');
    expect(h.billing.writes - w).toBe(0);
  });

  // ---- refund: the designed disabled state (PBD §10) ------------------------------------------

  it('C4-REFUND-1 with the flag OFF (the default): a REFUND is created on Finance → Owner and fully approved, but its apply is refused REFUND_POLICY_NOT_APPROVED — no state change, no command, no provider call, ONE APPLY_REFUSED audit row; the read reports refund_execution_disabled', async () => {
    expect(process.env[REFUND_EXECUTION_FLAG]).toBeUndefined();
    const { t, acct } = await selfServiceTenant();
    h.billing.invoices.set('in_c4refund1', { account_ref: acct });
    const id = await approved('REFUND', t, refundPayload(4_000, 'in_c4refund1'));
    const w = h.billing.adjustmentCalls.length;
    const sigs = await approvalsJson(id);
    expect(await refusal(applyAs(id))).toBe('REFUSED:REFUND_POLICY_NOT_APPROVED');
    expect(await reqRow(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await commandsOf(id)).toEqual([]);
    expect(h.billing.adjustmentCalls.length - w).toBe(0);
    expect(await approvalsJson(id)).toEqual(sigs);
    const refused = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED'`, [id])).rows;
    expect(refused).toHaveLength(1);
    expect(refused[0].payload).toMatchObject({ action_type: 'REFUND', refusal: 'REFUND_POLICY_NOT_APPROVED' });
    expect(await h.adjustments.view(id)).toMatchObject({ status: 'NOT_APPLIED', refund_execution_disabled: true, operation: 'REFUND_CREATE' });
  });

  it('C4-REFUND-2 with the flag ON (tests only): the same path runs end to end (one refund write, pending until the refund webhook); a refund command found by the dispatcher after the flag is switched OFF again is FAILED REFUND_POLICY_NOT_APPROVED with no provider call', async () => {
    const { t, acct } = await selfServiceTenant();
    h.billing.invoices.set('in_c4refund2', { account_ref: acct });
    const id = await approved('REFUND', t, refundPayload(4_500, 'in_c4refund2'));
    const t2 = await selfServiceTenant();
    h.billing.invoices.set('in_c4refund3', { account_ref: t2.acct });
    const held = await approved('REFUND', t2.t, refundPayload(10, 'in_c4refund3'));
    process.env[REFUND_EXECUTION_FLAG] = '1';
    try {
      const out = await applyAs(id);
      expect(out).toMatchObject({ status: 'PENDING_PROVIDER', refund_execution_disabled: false });
      expect(out.commands[0]).toMatchObject({ command_kind: 'REFUND_CREATE', target_ref: 'in_c4refund2', params: { amount_minor: 4_500, currency: 'USD', account_ref: acct } });
      await dispatch();
      const [c] = await commandsOf(id);
      expect(c.provider_object_ref).toMatch(/^re_c4_/);
      expect((await reqRow(id)).state).toBe('APPLYING');
      expect(await deliverObject(c.provider_object_ref, 'refund.updated')).toMatchObject({ outcome: 'APPLIED' });
      expect(await adjustmentOf(id)).toMatchObject({ action_type: 'REFUND', operation: 'REFUND_CREATE', provider_target_ref: 'in_c4refund2' });
      await applyAs(held); // queued while the flag is on …
    } finally {
      delete process.env[REFUND_EXECUTION_FLAG];
    }
    const w = h.billing.writes;
    await dispatch(); // … and found after it is switched off
    expect((await commandsOf(held))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_POLICY_NOT_APPROVED' });
    expect(h.billing.writes - w).toBe(0);
    expect((await reqRow(held)).state).toBe('APPLYING');
    expect(await refusal(applyAs(held))).toBe('REFUSED:REFUND_POLICY_NOT_APPROVED'); // and cannot be re-armed while off
  });

  // ---- recovery: compensation through a new change request ------------------------------------

  it('C4-COMP-1 an applied credit is compensated by a NEW change request (full chain on its own amount): the equal provider debit is a durable command too; a second compensation of the same credit fails ALREADY_COMPENSATED; a mismatched amount fails COMPENSATION_MISMATCH; a compensation of a discount removes exactly that discount', async () => {
    const settle = async (id: string) => {
      await applyAs(id);
      await dispatch();
      await h.commands.reconcilePending('sign', now);
      expect((await reqRow(id)).state).toBe('APPLIED');
    };
    // Tenant A: credit, compensation, a second compensation.
    const A = await selfServiceTenant();
    const orig = await approved('CREDIT', A.t, { amount_minor: 55_000, currency: 'USD' });
    await settle(orig);
    const comp = await approved('CREDIT', A.t, { amount_minor: 55_000, currency: 'USD', compensates_change_request_id: orig });
    expect(await chainRule(comp)).toBe('FINANCE_THEN_OWNER'); // thresholds on its own amount
    const out = await applyAs(comp);
    expect(out).toMatchObject({ operation: 'CREDIT_REVERSE' });
    expect(out.commands[0]).toMatchObject({ command_kind: 'CREDIT_REVERSE', step: 'credit_reverse', target_ref: A.acct, params: { subscription_id: A.ss, amount_minor: 55_000 } });
    await dispatch();
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(comp)).state).toBe('APPLIED');
    expect(h.billing.balance.filter((b) => b.account_ref === A.acct).map((b) => b.amount)).toEqual([-55_000, 55_000]);
    expect(await adjustmentOf(comp)).toMatchObject({ operation: 'CREDIT_REVERSE', compensates_change_request_id: orig });
    const twice = await approved('CREDIT', A.t, { amount_minor: 55_000, currency: 'USD', compensates_change_request_id: orig });
    expect(await refusal(applyAs(twice))).toBe('FAILED:ALREADY_COMPENSATED');
    expect(await commandsOf(twice)).toEqual([]);
    // Tenant B: a mismatched compensation.
    const B = await selfServiceTenant();
    const origB = await approved('CREDIT', B.t, { amount_minor: 700, currency: 'USD' });
    await settle(origB);
    const bad = await approved('CREDIT', B.t, { amount_minor: 699, currency: 'USD', compensates_change_request_id: origB });
    expect(await refusal(applyAs(bad))).toBe('FAILED:COMPENSATION_MISMATCH');
    expect(await commandsOf(bad)).toEqual([]);
    // Tenant C: a discount and its removal.
    const C = await selfServiceTenant();
    const disc = await approved('DISCOUNT', C.t, { discount_bps: 1_000 });
    await settle(disc);
    expect(h.billing.discounts.get(C.ref)).toMatchObject({ coupon_ref: discountCouponRef(disc) });
    const undo = await approved('DISCOUNT', C.t, { discount_bps: 1_000, compensates_change_request_id: disc });
    const u = await applyAs(undo);
    expect(u.commands[0]).toMatchObject({ command_kind: 'DISCOUNT_REMOVE', params: { coupon_ref: discountCouponRef(disc) } });
    await dispatch();
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(undo)).state).toBe('APPLIED');
    expect(h.billing.discounts.get(C.ref)).toBeUndefined();
  });

  // ---- NC-1 … NC-5, self-approval, one person holding two roles (Charter §6.4) ----------------

  it('C4-NC-1 concurrent approval: two Finance approvers sign the same step of a credit at once — exactly one succeeds, the other is refused; no double advance', async () => {
    const { t } = await selfServiceTenant();
    const r = await create('CREDIT', t, { amount_minor: 60_000, currency: 'USD' });
    await submit(r.request.id);
    const res = await Promise.allSettled([approveFa(r.request.id, FA), approveFa(r.request.id, FA2)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rej = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(CommercialApprovalRefusedError);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [r.request.id])).rows[0].n).toBe(1);
    expect((await reqRow(r.request.id)).state).toBe('PENDING_APPROVAL');
  });

  it('C4-NC-2 reused identities / one person holding two roles: a user holding finance_admin AND platform_owner signs the Finance step and is refused the Owner step (USER_ALREADY_APPROVED); a requester who also holds finance_admin cannot approve their own discount (SELF_APPROVAL)', async () => {
    const BOTH = await addOperator(pg, ['finance_admin', 'platform_owner']);
    const both = as(BOTH, 'finance_admin', { scopes: [...new Set([...(CCP_BUNDLES['finance_admin'] ?? []), ...(CCP_BUNDLES['platform_owner'] ?? [])])] });
    const { t } = await selfServiceTenant();
    const r = await create('DISCOUNT', t, { discount_bps: 2_500 });
    await submit(r.request.id);
    await h.changeRequests.approve(both, r.request.id, { step_index: 0 }, A6_CTX);
    expect(await refusal(h.changeRequests.approve(both, r.request.id, { step_index: 1 }, A6_CTX))).toBe('APPROVAL:USER_ALREADY_APPROVED');
    const MAKER = await addOperator(pg, ['commercial_ops', 'finance_admin']);
    const maker = as(MAKER, 'commercial_ops', { scopes: [...new Set([...(CCP_BUNDLES['commercial_ops'] ?? []), ...(CCP_BUNDLES['finance_admin'] ?? [])])] });
    const t2 = (await selfServiceTenant()).t;
    const own = await h.changeRequests.create(maker, { action_type: 'DISCOUNT', tenant_id: t2, product_key: 'sign', payload: { discount_bps: 100 }, reason: 'self', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(maker, own.request.id, A6_CTX);
    expect(await refusal(h.changeRequests.approve(maker, own.request.id, { step_index: 0 }, A6_CTX))).toBe('APPROVAL:SELF_APPROVAL');
  });

  it('C4-NC-3 stale chain: a credit whose approval window (72 h, D5) passed is refused at approve time (EXPIRED) and can never be applied (no command, no provider call)', async () => {
    const { t } = await selfServiceTenant();
    const r = await create('CREDIT', t, { amount_minor: 100, currency: 'USD' });
    await submit(r.request.id);
    const t0 = now;
    now = new Date(t0.getTime() + 72 * H); // exactly 72 h: expired (A2-B half-open)
    try {
      expect(await refusal(approveFa(r.request.id))).toBe('APPROVAL:EXPIRED');
      expect(await refusal(applyAs(r.request.id))).toBe('REFUSED:NOT_APPROVED');
    } finally {
      now = t0;
    }
    expect(await commandsOf(r.request.id)).toEqual([]);
  });

  it('C4-NC-4 role revocation: an approver whose finance_admin role was revoked after the request was created is refused at approve time (eligibility read in the transaction); a role revoked AFTER signing makes the apply refuse (APPROVER_NO_LONGER_ELIGIBLE) with no command, and the original signature is preserved byte-identical (TD-A3-0)', async () => {
    const F3 = await addOperator(pg, ['finance_admin']);
    const { t } = await selfServiceTenant();
    const r = await create('CREDIT', t, { amount_minor: 100, currency: 'USD' });
    await submit(r.request.id);
    await revokeRole(pg, F3, 'finance_admin');
    expect(await refusal(approveFa(r.request.id, F3))).toBe('APPROVAL:STEP_SCOPE_MISSING');
    await grantRole(pg, F3, 'finance_admin');
    await approveFa(r.request.id, F3);
    const sigs = await approvalsJson(r.request.id);
    await revokeRole(pg, F3, 'finance_admin');
    const w = h.billing.writes;
    expect(await refusal(applyAs(r.request.id))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await reqRow(r.request.id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await commandsOf(r.request.id)).toEqual([]);
    expect(await approvalsJson(r.request.id)).toEqual(sigs);
    expect(h.billing.writes - w).toBe(0);
    await grantRole(pg, F3, 'finance_admin');
  });

  it('C4-AUTH-1 requester-only apply (TD-B2-3): another commercial_ops, a Finance approver of the request, and a service principal are refused before anything is written', async () => {
    const { t } = await selfServiceTenant();
    const id = await approved('DISCOUNT', t, { discount_bps: 300 });
    expect(await refusal(applyAs(id, OPS2))).toBe('NOT_REQUESTER');
    expect(await refusal(applyAs(id, FA, 'finance_admin'))).toBe('REQUESTER_SCOPE_MISSING');
    expect(await refusal(h.adjustments.apply(as(OPS, 'commercial_ops', { actor_kind: 'service' }), id, A6_CTX))).toBe('NOT_HUMAN');
    expect(await reqRow(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await commandsOf(id)).toEqual([]);
    // The generic A6 apply route does not apply billing adjustments.
    expect(await refusal(h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX))).toBe('ACTION_NOT_APPLICABLE');
  });

  // ---- the database backstops ------------------------------------------------------------------

  it('C4-DB-1 DB guard: an action issues only its own command kinds; a C4 request cannot commit in APPLYING without a command, nor become APPLIED without the provider-confirmed adjustment; the adjustment record is append-only; provider_object_ref is written once; the closed C4 params are enforced', async () => {
    const { t, ss, acct } = await selfServiceTenant();
    const id = await approved('DISCOUNT', t, { discount_bps: 700 });
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES ($1, 'STRIPE', 'CREDIT_GRANT', $2::uuid, 'credit_grant', 'aramo-ccp-' || $2::text || '-credit_grant', $3, 'sign', $4, $5::jsonb, 'PENDING', 0, $6, now(), now())`,
        [randomUUID(), id, t, acct, JSON.stringify({ subscription_id: ss, amount_minor: 1, currency: 'USD' }), OPS],
      ),
    ).toContain('does not issue CREDIT_GRANT commands');
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES ($1, 'STRIPE', 'DISCOUNT_APPLY', $2::uuid, 'discount_apply', 'aramo-ccp-' || $2::text || '-discount_apply', $3, 'sign', 'sub_x', $4::jsonb, 'PENDING', 0, $5, now(), now())`,
        [randomUUID(), id, t, JSON.stringify({ subscription_id: ss, discount_bps: 700, coupon_ref: 'c', extra: 1 }), OPS],
      ),
    ).toContain('BillingProviderCommand_c4_params_check');
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = apply_attempts + 1 WHERE id = $1`, [id])).toContain('cannot commit in APPLYING without a provider command');
    await applyAs(id);
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toContain('the provider-confirmed billing adjustment is missing');
    await dispatch();
    const [c] = await commandsOf(id);
    // A bare edit is refused by C1's guard (no transition); an edit riding a legal transition by the C4 guard.
    expect(await dbError(`UPDATE subscription."BillingProviderCommand" SET provider_object_ref = 'di_other' WHERE id = $1`, [c.id])).toContain('refused');
    expect(
      await dbError(`UPDATE subscription."BillingProviderCommand" SET state = 'CONFIRMED', confirmed_at = now(), confirmation_source = 'REFETCH', provider_object_ref = 'di_other' WHERE id = $1`, [c.id]),
    ).toContain('written once');
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(id)).state).toBe('APPLIED');
    expect(await dbError(`UPDATE subscription."CommercialBillingAdjustment" SET discount_bps = 1 WHERE change_request_id = $1`, [id])).toContain('append-only');
    expect(await dbError(`DELETE FROM subscription."CommercialBillingAdjustment" WHERE change_request_id = $1`, [id])).toContain('append-only');
    // The request action list admits REFUND (constraint union) and nothing invented.
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET action_type = 'REFUND_TYPO' WHERE id = $1`, [id])).toMatch(/action_type_check|immutable/);
  });

  // ---- CCP-C4-R (Architect C4 disposition 2026-10-25, TD-C4-12 / TD-C4-1 / TD-C4-18) ------------

  /** An APPROVED REFUND (Finance → Owner) on a fresh self-service tenant whose invoice the fake knows. */
  async function approvedRefund(amount_minor: number, invoice: { amount_paid?: number } = {}): Promise<{ id: string; t: string; acct: string; inv: string }> {
    const s = await selfServiceTenant();
    const inv = `in_c4r${String(++keyN).padStart(6, '0')}`;
    h.billing.invoices.set(inv, { account_ref: s.acct, ...invoice });
    const id = await approved('REFUND', s.t, refundPayload(amount_minor, inv));
    return { id, t: s.t, acct: s.acct, inv };
  }
  const withFlag = async <T>(f: () => Promise<T>): Promise<T> => {
    process.env[REFUND_EXECUTION_FLAG] = '1';
    try {
      return await f();
    } finally {
      delete process.env[REFUND_EXECUTION_FLAG];
    }
  };
  const resolve = (id: string, user = OPS) => h.adjustments.resolveRefund(as(user, 'commercial_ops'), id, A6_CTX);
  const later = (min: number) => {
    now = new Date(now.getTime() + min * 60_000);
  };
  const auditCount = async (id: string, type: string) => Number((await one(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = $2`, [id, type])).n);

  it('C4R-1 (the Architect\'s example) a $300 refund is sent, Stripe processes it, the response is lost, then the flag is DISABLED: the reconciliation still runs — the dispatcher re-reads and records it (0 further writes), the re-fetch confirms it APPLIED with its adjustment; never a second command or refund', async () => {
    const { id, inv } = await approvedRefund(30_000);
    const t0 = now;
    try {
      await withFlag(async () => {
        await applyAs(id);
        const [c] = await commandsOf(id);
        h.billing.lostResponses.set(c.id, 1);
        await dispatch(); // Stripe executes, the response is lost
      });
      const [c] = await commandsOf(id);
      expect(c).toMatchObject({ state: 'RETRY_WAIT', last_error_code: 'PROVIDER_UNAVAILABLE' });
      expect(h.billing.refunds.filter((r) => r.invoice_ref === inv)).toHaveLength(1);
      const writes = h.billing.writes;
      // Flag OFF from here. The due retry re-reads first: the refund exists → recorded, never re-sent.
      later(2);
      await dispatch();
      expect((await commandsOf(id))[0]).toMatchObject({ state: 'PENDING_PROVIDER', last_error_detail: 'already in effect at the provider' });
      expect((await reqRow(id)).state).toBe('APPLYING');
      await h.commands.reconcilePending('sign', now);
      expect((await reqRow(id)).state).toBe('APPLIED');
      expect(await adjustmentOf(id)).toMatchObject({ action_type: 'REFUND', operation: 'REFUND_CREATE', provider_target_ref: inv, confirmation_source: 'REFETCH' });
      expect(h.billing.writes - writes).toBe(0);
      expect(await commandsOf(id)).toHaveLength(1);
      expect(h.billing.refunds.filter((r) => r.invoice_ref === inv)).toHaveLength(1);
      expect(await auditCount(id, 'COMMERCIAL_REFUND_CONFIRMED')).toBe(1);
      expect(await auditCount(id, 'COMMERCIAL_REFUND_PENDING_PROVIDER')).toBe(1);
    } finally {
      now = t0;
    }
  });

  it('C4R-2 the same lost-response refund, flag off, resolved by its requester: the resolution reconciles FIRST, finds the refund CONFIRMED and records it APPLIED (never withdrawn); a verified refund webhook also confirms while the flag is off', async () => {
    const t0 = now;
    try {
      const a = await approvedRefund(30_000);
      await withFlag(async () => {
        await applyAs(a.id);
        h.billing.lostResponses.set((await commandsOf(a.id))[0].id, 1);
        await dispatch();
      });
      const w = h.billing.writes;
      const out = await resolve(a.id);
      expect(out).toMatchObject({ resolution: 'CONFIRMED', outcomes: ['CONFIRMED'], status: 'APPLIED', request: { state: 'APPLIED' } });
      expect(h.billing.writes - w).toBe(0);
      // Webhook path, flag off.
      const b = await approvedRefund(5_000);
      await withFlag(async () => {
        await applyAs(b.id);
        await dispatch();
      });
      const [c] = await commandsOf(b.id);
      expect(await deliverObject(c.provider_object_ref, 'refund.updated')).toMatchObject({ outcome: 'APPLIED' });
      expect((await reqRow(b.id)).state).toBe('APPLIED');
    } finally {
      now = t0;
    }
  });

  it('C4R-3 the re-fetch proves NO refund exists: only the revalidated requester may resolve; one COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED event; APPLYING → WITHDRAWN; the slot is released on commit; the command stays as evidence and is never sent afterwards', async () => {
    // (a) a provider refusal (nothing created), then the flag is disabled
    const a = await approvedRefund(30_000);
    await withFlag(async () => {
      await applyAs(a.id);
      h.billing.adjustmentFailures.set((await commandsOf(a.id))[0].id, { kind: 'refused', times: 1 });
      await dispatch();
    });
    expect((await commandsOf(a.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'PROVIDER_REFUSED' });
    expect(await refusal(resolve(a.id, OPS2))).toBe('NOT_REQUESTER');
    expect(await refusal(h.adjustments.resolveRefund(as(FA, 'finance_admin'), a.id, A6_CTX))).toBe('REQUESTER_SCOPE_MISSING');
    const sigs = await approvalsJson(a.id);
    const w = h.billing.writes;
    const out = await resolve(a.id);
    expect(out).toMatchObject({ resolution: 'RESOLVED_NOT_EXECUTED', outcomes: ['NOT_FOUND'], status: 'RESOLVED_NOT_EXECUTED', request: { state: 'WITHDRAWN' } });
    expect((await reqRow(a.id)).withdrawn_at).not.toBeNull();
    expect(await auditCount(a.id, 'COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED')).toBe(1);
    expect(await approvalsJson(a.id)).toEqual(sigs);
    expect(await commandsOf(a.id)).toHaveLength(1);
    expect(await adjustmentOf(a.id)).toBeUndefined();
    // The slot is free: a new REFUND on the same tenant is accepted.
    const again = await create('REFUND', a.t, refundPayload(100, a.inv));
    expect(again.request.state).toBe('DRAFT');
    // Terminal: a second resolution / apply is refused; the old command is never sent.
    expect(await refusal(resolve(a.id))).toBe('REFUSED:NOT_RESOLVABLE');
    await withFlag(async () => {
      await pg.query(`UPDATE subscription."BillingProviderCommand" SET state = 'PENDING' WHERE change_request_id = $1`, [a.id]); // an operator retry of the old command …
      await dispatch(); // … is refused before any provider call: the request is no longer APPLYING
    });
    expect((await commandsOf(a.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REQUEST_NOT_APPLYING' });
    expect(h.billing.writes - w).toBe(0);
    // (b) applied while the flag was on but never sent; the flag goes off; dispatch makes no new refund
    const b = await approvedRefund(2_000);
    await withFlag(() => applyAs(b.id));
    await dispatch();
    expect((await commandsOf(b.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_POLICY_NOT_APPROVED' });
    expect(await resolve(b.id)).toMatchObject({ resolution: 'RESOLVED_NOT_EXECUTED', outcomes: ['NOT_FOUND'] });
    // (c) a refund the provider reports FAILED can no longer complete: resolvable too
    const c = await approvedRefund(3_000);
    h.billing.refundStatus = 'failed';
    try {
      await withFlag(async () => {
        await applyAs(c.id);
        await dispatch();
      });
    } finally {
      h.billing.refundStatus = 'succeeded';
    }
    expect(await resolve(c.id)).toMatchObject({ resolution: 'RESOLVED_NOT_EXECUTED', outcomes: ['FAILED_AT_PROVIDER'] });
  });

  it('C4R-4 the outcome is uncertain — the re-fetch errors, the refund is still pending, or it exists for another amount (PARTIAL): the resolution is refused REFUND_OUTCOME_UNCERTAIN, the request stays APPLYING and holds its slot; nothing is released, nothing re-sent', async () => {
    const a = await approvedRefund(30_000);
    await withFlag(async () => {
      await applyAs(a.id);
      h.billing.adjustmentFailures.set((await commandsOf(a.id))[0].id, { kind: 'refused', times: 1 });
      await dispatch();
    });
    const [c] = await commandsOf(a.id);
    h.billing.readFailures.add(c.id);
    const w = h.billing.writes;
    try {
      expect(await refusal(resolve(a.id))).toBe(`REFUSED:REFUND_OUTCOME_UNCERTAIN`);
    } finally {
      h.billing.readFailures.delete(c.id);
    }
    expect(await reqRow(a.id)).toMatchObject({ state: 'APPLYING', withdrawn_at: null });
    expect(await refusal(create('REFUND', a.t, refundPayload(1, a.inv)))).toBe('OPEN_REQUEST_EXISTS');
    expect(await auditCount(a.id, 'COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED')).toBe(0);
    expect(await auditCount(a.id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).toBe(1);
    // pending at the provider
    const p = await approvedRefund(4_000);
    h.billing.refundStatus = 'pending';
    try {
      await withFlag(async () => {
        await applyAs(p.id);
        await dispatch();
      });
    } finally {
      h.billing.refundStatus = 'succeeded';
    }
    expect(await refusal(resolve(p.id))).toBe('REFUSED:REFUND_OUTCOME_UNCERTAIN');
    expect((await reqRow(p.id)).state).toBe('APPLYING');
    // a refund of this command for another amount (PARTIAL) is never applied nor resolved
    const q = await approvedRefund(6_000);
    await withFlag(() => applyAs(q.id));
    const [qc] = await commandsOf(q.id);
    h.billing.refunds.push({ id: 're_c4r_partial', invoice_ref: q.inv, amount: 5_000, status: 'succeeded', command_id: qc.id, tenant_id: q.t });
    await dispatch(); // the pre-read finds a refund for this command: recorded, never re-sent
    expect((await commandsOf(q.id))[0]).toMatchObject({ state: 'PENDING_PROVIDER', provider_object_ref: 're_c4r_partial' });
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(q.id)).state).toBe('APPLYING');
    expect(await refusal(resolve(q.id))).toBe('REFUSED:REFUND_OUTCOME_UNCERTAIN');
    // The only write in this test is the pending refund's own first send (flag on); nothing re-sent.
    expect(h.billing.writes - w).toBe(1);
    expect(h.billing.refunds.filter((r) => r.invoice_ref === p.inv)).toHaveLength(1);
    expect(h.billing.refunds.filter((r) => r.invoice_ref === q.inv)).toHaveLength(1);
    expect(h.billing.refunds.filter((r) => r.invoice_ref === a.inv)).toHaveLength(0);
  });

  it('C4R-5 refund identity: an over-refund is refused at CREATE (REFUND_EXCEEDS_REMAINDER, nothing written); a PARTIAL refund within the remainder is allowed and confirmed; a dispute opened after apply stops the dispatch before any write (REFUND_PAYMENT_DISPUTED)', async () => {
    const s = await selfServiceTenant();
    h.billing.invoices.set('in_c4rover', { account_ref: s.acct, amount_paid: 20_000 });
    expect(await refusal(create('REFUND', s.t, refundPayload(30_000, 'in_c4rover')))).toBe('NOT_REFUNDABLE:REFUND_EXCEEDS_REMAINDER');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1`, [s.t])).rows[0].n).toBe(0);
    const part = await approvedRefund(10_000, { amount_paid: 20_000 });
    await withFlag(async () => {
      await applyAs(part.id);
      await dispatch();
    });
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(part.id)).state).toBe('APPLIED');
    expect(Number((await adjustmentOf(part.id)).amount_minor)).toBe(10_000);
    const disputed = await approvedRefund(5_000);
    const w = h.billing.writes;
    await withFlag(async () => {
      await applyAs(disputed.id);
      h.billing.disputes.set(disputed.inv, [{ status: 'needs_response', amount: 5_000 }]);
      await dispatch();
    });
    expect((await commandsOf(disputed.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_PAYMENT_DISPUTED' });
    expect(h.billing.writes - w).toBe(0);
  });

  it('C4R-6 DB backstops of the resolution: no WITHDRAWN without its resolution audit event; never while a command is in flight; only REFUND (a CREDIT in APPLYING cannot be withdrawn)', async () => {
    const a = await approvedRefund(1_000);
    await withFlag(() => applyAs(a.id));
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'WITHDRAWN', withdrawn_at = now() WHERE id = $1`, [a.id])).toContain('needs its COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED audit event');
    const { t } = await selfServiceTenant();
    const cr = await approved('CREDIT', t, { amount_minor: 100, currency: 'USD' });
    await applyAs(cr);
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET state = 'WITHDRAWN', withdrawn_at = now() WHERE id = $1`, [cr])).toContain('APPLYING -> WITHDRAWN is not allowed');
    await dispatch();
    await h.commands.reconcilePending('sign', now);
  });

  it('C4R-7 (TD-C4-18) an approved manual CREDIT on a COMMITTED self-service subscription is applied without touching the subscription: the row (commitment term, period, status — the inputs of C7\'s cancel refusal) is byte-identical, and C2\'s conversion is still refused FINANCIAL_TREATMENT_UNDEFINED', async () => {
    const { t, ss } = await selfServiceTenant();
    await pg.query(`UPDATE subscription."TenantSubscription" SET commitment_start = $2, commitment_end = $3 WHERE id = $1`, [ss, new Date(T0.getTime() - 30 * 24 * H), new Date(T0.getTime() + 300 * 24 * H)]);
    const before = (await one(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [ss])).j as string;
    const credit = await approved('CREDIT', t, { amount_minor: 5_000, currency: 'USD', subscription_id: ss });
    await applyAs(credit);
    await dispatch();
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(credit)).state).toBe('APPLIED');
    expect((await one(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [ss])).j).toBe(before);
    const conv = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: { direction: 'TO_GOVERNED', subscription_id: ss, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED) }, reason: 'convert after a credit', idempotency_key: key() }, A6_CTX);
    await submit(conv.request.id);
    await approveFa(conv.request.id);
    expect(await refusal(h.conversions.apply(as(OPS, 'commercial_ops'), conv.request.id, A6_CTX))).toBe('CONVERSION_FAILED:FINANCIAL_TREATMENT_UNDEFINED');
    expect(await commandsOf(conv.request.id)).toEqual([]);
    expect((await one(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [ss])).j).toBe(before);
  });

  // ---- CCP-C4-P (Amendment A1 RF-3…RF-5, Architect C4-P gaps 1–3) -------------------------------

  /** A self-service tenant whose invoice (paid `paid`) the fake knows. */
  async function paidInvoice(paid: number, o: { currency?: string } = {}): Promise<{ t: string; acct: string; inv: string; ss: string }> {
    const s = await selfServiceTenant();
    const inv = `in_c4p${String(++keyN).padStart(6, '0')}`;
    h.billing.invoices.set(inv, { account_ref: s.acct, amount_paid: paid, ...o });
    return { t: s.t, acct: s.acct, ss: s.ss, inv };
  }
  /** The gate, directly, in a rolled-back transaction under the billing lock (as create / apply run it). */
  async function gate(t: string, inv: string, amount_minor: number, exclude?: string): Promise<string> {
    const picture = await h.refundGate.readPicture(inv);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${t}`}, 0))`;
        await h.refundGate.assertInTx(tx, picture, refundBindingOf(t, 'sign', refundPayload(amount_minor, inv), exclude));
        throw new Error('ROLLBACK_OK');
      });
    } catch (e) {
      if ((e as Error).message === 'ROLLBACK_OK') return 'OK';
      if (e instanceof RefundRemainderRefusedError) return e.refusal;
      throw e;
    }
    return 'UNREACHABLE';
  }
  /** A refund confirmed end to end (flag on for its send only). */
  async function confirmedRefund(t: string, inv: string, amount_minor: number): Promise<string> {
    const id = await approved('REFUND', t, refundPayload(amount_minor, inv));
    await withFlag(async () => {
      await applyAs(id);
      await dispatch();
    });
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(id)).state).toBe('APPLIED');
    return id;
  }

  it('C4P-1 RF-4 example: paid $1,000 with a confirmed $300 refund → $700 can still be requested, $701 is refused at create (REFUND_EXCEEDS_REMAINDER); the remainder is the provider\'s (captured − confirmed)', async () => {
    const p = await paidInvoice(100_000);
    await confirmedRefund(p.t, p.inv, 30_000);
    expect(await refusal(create('REFUND', p.t, refundPayload(70_001, p.inv)))).toBe('NOT_REFUNDABLE:REFUND_EXCEEDS_REMAINDER');
    const ok = await create('REFUND', p.t, refundPayload(70_000, p.inv));
    expect(ok.request).toMatchObject({ state: 'DRAFT', payload: { amount_minor: 70_000, category: 'R4_SERVICE_FAILURE', refund_policy_ref: 'aramo-refund-policy@v1-draft' } });
  });

  it('C4P-2 an uncertain $200 command still held reserves its amount (never refundable again while uncertain); excluding that request shows the reservation is the only difference', async () => {
    const p = await paidInvoice(100_000);
    const held = await approved('REFUND', p.t, refundPayload(20_000, p.inv));
    await withFlag(async () => {
      await applyAs(held);
      h.billing.adjustmentFailures.set((await commandsOf(held))[0].id, { kind: 'refused', times: 1 });
      await dispatch();
    });
    expect(await reqRow(held)).toMatchObject({ state: 'APPLYING' });
    expect(await gate(p.t, p.inv, 80_000)).toBe('OK');
    expect(await gate(p.t, p.inv, 80_001)).toBe('REFUND_EXCEEDS_REMAINDER');
    expect(await gate(p.t, p.inv, 100_000, held)).toBe('OK');
  });

  it('C4P-3 a provider refund that matches a local command (by its command id, the lost-response case) is counted ONCE, not twice', async () => {
    const p = await paidInvoice(100_000);
    const id = await approved('REFUND', p.t, refundPayload(20_000, p.inv));
    const t0 = now;
    try {
      await withFlag(async () => {
        await applyAs(id);
        h.billing.lostResponses.set((await commandsOf(id))[0].id, 1);
        await dispatch();
      });
      expect((await commandsOf(id))[0]).toMatchObject({ state: 'RETRY_WAIT', provider_object_ref: null });
      expect(h.billing.refunds.filter((r) => r.invoice_ref === p.inv)).toHaveLength(1);
      expect(await gate(p.t, p.inv, 80_000)).toBe('OK'); // 100 000 − 20 000 once (not 60 000)
      expect(await gate(p.t, p.inv, 80_001)).toBe('REFUND_EXCEEDS_REMAINDER');
    } finally {
      now = t0;
    }
  });

  it('C4P-4 disputes: an open or unresolved dispute blocks every refund (REFUND_PAYMENT_DISPUTED); a lost dispute reduces the remainder; a won one does not', async () => {
    const p = await paidInvoice(100_000);
    for (const status of ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']) {
      h.billing.disputes.set(p.inv, [{ status, amount: 10_000 }]);
      expect(await refusal(create('REFUND', p.t, refundPayload(1, p.inv))), status).toBe('NOT_REFUNDABLE:REFUND_PAYMENT_DISPUTED');
    }
    h.billing.disputes.set(p.inv, [{ status: 'lost', amount: 30_000 }]);
    expect(await gate(p.t, p.inv, 70_001)).toBe('REFUND_EXCEEDS_REMAINDER');
    expect(await gate(p.t, p.inv, 70_000)).toBe('OK');
    h.billing.disputes.set(p.inv, [{ status: 'won', amount: 30_000 }]);
    expect(await gate(p.t, p.inv, 100_000)).toBe('OK');
    h.billing.disputes.set(p.inv, [{ status: 'something_new', amount: 1 }]);
    expect(await gate(p.t, p.inv, 1)).toBe('REFUND_REMAINDER_UNVERIFIABLE');
  });

  it('C4P-5 never guessed / bound (RF-5): a provider read failure or a truncated list → REFUND_REMAINDER_UNVERIFIABLE; another payment, another tenant\'s invoice → REFUND_PAYMENT_MISMATCH; another currency → REFUND_CURRENCY_MISMATCH; nothing is created', async () => {
    const p = await paidInvoice(100_000);
    h.billing.pictureFailures.add(p.inv);
    expect(await refusal(create('REFUND', p.t, refundPayload(1, p.inv)))).toBe('NOT_REFUNDABLE:REFUND_REMAINDER_UNVERIFIABLE');
    h.billing.pictureFailures.delete(p.inv);
    h.billing.pictureTruncated.add(p.inv);
    expect(await refusal(create('REFUND', p.t, refundPayload(1, p.inv)))).toBe('NOT_REFUNDABLE:REFUND_REMAINDER_UNVERIFIABLE');
    h.billing.pictureTruncated.delete(p.inv);
    expect(await refusal(create('REFUND', p.t, refundPayload(1, p.inv, { provider_payment_ref: 'pi_someotherpayment' })))).toBe('NOT_REFUNDABLE:REFUND_PAYMENT_MISMATCH');
    const other = await paidInvoice(100_000);
    expect(await refusal(create('REFUND', p.t, refundPayload(1, other.inv)))).toBe('NOT_REFUNDABLE:REFUND_PAYMENT_MISMATCH');
    const eur = await paidInvoice(100_000, { currency: 'eur' });
    expect(await refusal(create('REFUND', eur.t, refundPayload(1, eur.inv)))).toBe('NOT_REFUNDABLE:REFUND_CURRENCY_MISMATCH');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = ANY($1::uuid[])`, [[p.t, eur.t]])).rows[0].n).toBe(0);
  });

  it('C4P-6 payload provenance (gap 2): a closed category, a non-empty basis and a refund_policy_ref are required, with stable codes; they are immutable under the checksum; a policy ref NEVER makes a refund executable (still REFUND_POLICY_NOT_APPROVED, 0 Stripe refund calls)', async () => {
    const p = await paidInvoice(100_000);
    const codes = async (payload: Record<string, unknown>): Promise<unknown> => {
      try {
        await create('REFUND', p.t, payload);
        return 'OK';
      } catch (e) {
        return (e as CommercialChangeRequestError).details['codes'];
      }
    };
    expect(await codes(refundPayload(1, p.inv, { category: 'R9_WHATEVER' }))).toEqual(['REFUND_CATEGORY_INVALID']);
    expect(await codes(refundPayload(1, p.inv, { basis: '   ' }))).toEqual(['REFUND_BASIS_REQUIRED']);
    const { refund_policy_ref: _drop, ...noRef } = refundPayload(1, p.inv);
    expect(await codes(noRef)).toEqual(['REFUND_POLICY_REF_REQUIRED']);
    expect(await codes(refundPayload(1, p.inv, { refund_policy_ref: 'no-version' }))).toEqual(['REFUND_POLICY_REF_REQUIRED']);
    const { provider_payment_ref: _p, ...noPay } = refundPayload(1, p.inv);
    expect(await codes(noPay)).toEqual(['REFUND_PAYMENT_REF_INVALID']);
    const id = await approved('REFUND', p.t, refundPayload(5_000, p.inv, { category: 'R7_GOODWILL' }));
    expect(await dbError(`UPDATE subscription."CommercialChangeRequest" SET payload = jsonb_set(payload, '{category}', '"R1_DUPLICATE"') WHERE id = $1`, [id])).toContain('immutable');
    const calls = h.billing.adjustmentCalls.length;
    expect(await refusal(applyAs(id))).toBe('REFUSED:REFUND_POLICY_NOT_APPROVED');
    expect(h.billing.adjustmentCalls.length - calls).toBe(0);
    expect(h.billing.refunds.filter((r) => r.invoice_ref === p.inv)).toHaveLength(0);
  });

  it('C4P-7 the remainder is decided again at APPLY under the billing lock: a refund made elsewhere after approval leaves too little → refused REFUND_EXCEEDS_REMAINDER, APPROVED kept, no command', async () => {
    const p = await paidInvoice(100_000);
    const id = await approved('REFUND', p.t, refundPayload(50_000, p.inv));
    h.billing.refunds.push({ id: 're_c4p_elsewhere', invoice_ref: p.inv, amount: 60_000, status: 'succeeded', command_id: 'not-aramo', tenant_id: p.t });
    await withFlag(async () => {
      expect(await refusal(applyAs(id))).toBe('REFUSED:REFUND_EXCEEDS_REMAINDER');
    });
    expect(await reqRow(id)).toMatchObject({ state: 'APPROVED', apply_attempts: 0 });
    expect(await commandsOf(id)).toEqual([]);
  });

  it('C4P-8 concurrency: two concurrent REFUND creates on one payment → exactly one (Q14 + billing lock); two concurrent applies → one command; two concurrent dispatches → one provider refund', async () => {
    const p = await paidInvoice(100_000);
    const both = await Promise.allSettled([create('REFUND', p.t, refundPayload(60_000, p.inv)), create('REFUND', p.t, refundPayload(60_000, p.inv))]);
    expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(((both.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason as CommercialChangeRequestError).code).toBe('OPEN_REQUEST_EXISTS');
    const id = ((both.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{ request: { id: string } }>).value).request.id;
    await submit(id);
    await approveFa(id);
    await approvePo(id);
    await withFlag(async () => {
      const applies = await Promise.allSettled([applyAs(id), applyAs(id)]);
      expect(applies.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      expect(await commandsOf(id)).toHaveLength(1);
      await Promise.all([dispatch(), dispatch()]);
    });
    expect(h.billing.refunds.filter((r) => r.invoice_ref === p.inv)).toHaveLength(1);
    await h.commands.reconcilePending('sign', now);
    expect((await reqRow(id)).state).toBe('APPLIED');
  });

  it('C4P-9 refund report (gap 3): a projection of the existing records — confirmed rows carry the effective date (the provider confirmation) and its UTC accounting month; held, resolved and requested rows their own states', async () => {
    const p = await paidInvoice(100_000);
    const id = await confirmedRefund(p.t, p.inv, 12_345);
    const out = await new CommercialRefundReportService(prisma).list({ tenant_id: p.t });
    expect(out.refunds).toHaveLength(1);
    const cmd = (await commandsOf(id))[0];
    expect(out.refunds[0]).toMatchObject({ change_request_id: id, refund_state: 'confirmed', reconciliation_status: 'CONFIRMED', category: 'R4_SERVICE_FAILURE', amount_minor: 12_345, provider_invoice_ref: p.inv, effective_at: cmd.confirmed_at, accounting_period: `${cmd.confirmed_at.getUTCFullYear()}-${String(cmd.confirmed_at.getUTCMonth() + 1).padStart(2, '0')}` });
    const r2 = await create('REFUND', p.t, refundPayload(1, p.inv));
    expect((await new CommercialRefundReportService(prisma).list({ tenant_id: p.t })).refunds.map((r) => [r.change_request_id, r.refund_state, r.reconciliation_status])).toEqual([
      [r2.request.id, 'requested', 'NOT_SENT'],
      [id, 'confirmed', 'CONFIRMED'],
    ]);
  });

  it('C4-TX-1 no provider call ran inside a local DB transaction across this spec (the fake\'s probe saw no open transaction and no locked command row on every call)', () => {
    expect(h.billing.probes).toBeGreaterThan(20);
    expect(h.billing.violations).toEqual([]);
  });

  // ---- NC-5 (last: activates the v2 test policy) -------------------------------------------------

  it('C4-NC-5 policy-version change: activating v2 (credit threshold $1,000, apply deadline 72 h) does not re-threshold the in-flight $500 credit (it keeps v1 and Finance → Owner); a new $500 credit under v2 is Finance-only; at apply the snapshotted chain is re-checked; a v2 credit not applied by its deadline expires (AD-4) and is never sent', async () => {
    const { t } = await selfServiceTenant();
    const inflight = await create('CREDIT', t, { amount_minor: 50_000, currency: 'USD' });
    await submit(inflight.request.id);
    const v2content = { ...(seededPolicyV1().content as Record<string, unknown>), credit_escalation_threshold_minor: 100_000, apply_expiry_hours: 72 };
    const v2 = await activatePolicyV2(pg, v2content, commercialPolicyChecksum(v2content));
    expect((await approveFa(inflight.request.id)).request).toMatchObject({ state: 'PENDING_APPROVAL', policy_version_id: POLICY_V1 });
    await approvePo(inflight.request.id);
    expect((await applyAs(inflight.request.id)).request.state).toBe('APPLYING');

    const T2 = await selfServiceTenant();
    const t2 = T2.t;
    const fresh = await create('CREDIT', t2, { amount_minor: 50_000, currency: 'USD' });
    expect(fresh.request).toMatchObject({ policy_version_id: v2 });
    expect(await chainRule(fresh.request.id)).toBe('FINANCE_ONLY');
    await submit(fresh.request.id);
    await approveFa(fresh.request.id);
    const t0 = now;
    now = new Date(t0.getTime() + 72 * H); // exactly the apply deadline (half-open, AD-3)
    const w = h.billing.writes;
    try {
      expect(await refusal(applyAs(fresh.request.id))).toBe('REFUSED:APPLY_EXPIRED');
      expect((await reqRow(fresh.request.id)).state).toBe('APPLY_EXPIRED');
      await dispatch();
    } finally {
      now = t0;
    }
    expect(await commandsOf(fresh.request.id)).toEqual([]);
    // (the in-flight v1 credit above was dispatched in the meantime: its own write, not this one's)
    expect(h.billing.writes - w).toBe(1);
    expect(h.billing.adjustmentCalls.filter((c) => c.op === 'executeAdjustment' && c.ref === T2.acct)).toEqual([]);
  });
});
