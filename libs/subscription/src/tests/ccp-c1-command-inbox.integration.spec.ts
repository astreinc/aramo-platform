import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingCommandError } from '../lib/billing/billing-command.service.js';
import { BILLING_COMMAND_MAX_ATTEMPTS } from '../lib/billing/billing-provider-command.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C1Harness, c1Harness } from './support/ccp-c1.js';

// CCP-C1 (PBD §5.2 row C1; Conversion Rule C-22, C-23) — the Stripe command outbox and the webhook
// inbox on real Postgres 17, with the real lifecycle, change-request and apply services and a FAKE
// Stripe (no network, no key). Mandatory tests: no Stripe call inside a local DB transaction;
// duplicate and out-of-order webhooks idempotent; retry after transient failure; failed commands
// visible; pending-provider state until the confirming event is applied. Plus: A6's hold still
// holds through the inbox. Test IDs are cited by doc/ccp/slices/CCP-C1-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C1 Stripe command outbox + webhook inbox (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let probe: Client;
  let prisma: PrismaService;
  let h: C1Harness;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  let evtN = 0;
  const key = () => `c1-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_c1_${String(++evtN).padStart(6, '0')}`;
  const env = { ...process.env };

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
    h = c1Harness(prisma, () => T0);
    h.billing.attachProbe(probe);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await probe?.end();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- fixtures ---------------------------------------------------------------------------

  /** An APPROVED CONVERSION change request (Finance-only chain, TD-A3-2) for the tenant. */
  async function approvedConversion(t: string): Promise<string> {
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: { c1_fixture: 'self_service_to_governed' }, reason: 'c1 conversion fixture', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return r.request.id;
  }
  /** A tenant with an open Stripe-owned SELF_SERVICE row; the fake provider holds its state. */
  async function selfServiceTenant(): Promise<{ t: string; ref: string; sub_id: string }> {
    const t = await newTenant(pg);
    const intent = randomUUID();
    const s = h.billing.state(t, intent);
    const sub_id = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    return { t, ref: s.subscription_ref, sub_id };
  }
  const cancel = (cr: string, t: string, ref: string, mode: 'IMMEDIATE' | 'AT_PERIOD_END' = 'IMMEDIATE', step = 'end_self_service') =>
    h.commands.enqueue({ change_request_id: cr, step, command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: t, product_key: 'sign', target_ref: ref, mode, created_by: OPS, at: T0 });
  const cmd = async (id: string) => (await pg.query(`SELECT * FROM subscription."BillingProviderCommand" WHERE id = $1`, [id])).rows[0];
  const sub = async (id: string) => (await pg.query(`SELECT * FROM subscription."TenantSubscription" WHERE id = $1`, [id])).rows[0];
  const rowJson = async (id: string) => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [id])).rows[0].j as string;
  const openRows = async (t: string) => (await pg.query(`SELECT source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY source`, [t])).rows.map((r) => r.source as string);
  const openFlags = async (t: string) => (await pg.query(`SELECT reason FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY reason`, [t])).rows.map((r) => r.reason as string);
  const intentStatus = async (id: string) => (await pg.query(`SELECT status FROM subscription."CheckoutIntent" WHERE id = $1`, [id])).rows[0].status as string;
  const inboxRow = async (event_id: string) => (await pg.query(`SELECT * FROM subscription."BillingWebhookInbox" WHERE provider_event_id = $1`, [event_id])).rows[0];
  const billingEvents = async (event_id: string) => (await pg.query(`SELECT outcome, detail FROM subscription."BillingEvent" WHERE provider_event_id = $1`, [event_id])).rows;
  const deliver = (ref: string, at: Date = T0, id: string = evtId(), type = 'subscription.updated', created: Date = at) =>
    h.inbox.receive({ id, type, created, subscription_ref: ref }, 'sign', at);
  async function dbError(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
      return 'OK';
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** Raw CheckoutIntent (CREATED) with a provider session. */
  async function rawIntent(t: string): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [id, t, `cs_${id}`, '2026-10-20T09:00:00.000Z', BUSINESS],
    );
    return id;
  }

  // ---- enqueue (the outbox) ------------------------------------------------------------------

  it('C1-ENQ-1 enqueue: PENDING, 0 attempts, key derived from change request + step; a repeat replays; a different command on the same step is refused; the DB refuses a free-text key', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const a = await cancel(cr, t, ref);
    expect(a.replayed).toBe(false);
    expect(a.command).toMatchObject({ state: 'PENDING', attempts: 0, idempotency_key: `aramo-ccp-${cr}-end_self_service`, params: { mode: 'IMMEDIATE' }, command_kind: 'SUBSCRIPTION_CANCEL' });
    const b = await cancel(cr, t, ref);
    expect(b).toMatchObject({ replayed: true, command: { id: a.command.id } });
    await expect(cancel(cr, t, ref, 'AT_PERIOD_END')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1, 'other_step', 'free-text', $2, 'sign', $3, '{"mode":"IMMEDIATE"}', 'PENDING', 0, $4, now(), now())`,
        [cr, t, ref, OPS],
      ),
    ).toContain('BillingProviderCommand_idempotency_key_check');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."BillingProviderCommand" WHERE change_request_id = $1`, [cr])).rows[0].n).toBe(1);
  });

  it('C1-ENQ-2 enqueue refusals: unapproved request (service and DB trigger), non-command action, other tenant, a target the tenant does not own, a governed (MANUAL) row', async () => {
    const { t, ref } = await selfServiceTenant();
    const pending = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: {}, reason: 'pending', idempotency_key: key() },
      A6_CTX,
    );
    await expect(cancel(pending.request.id, t, ref)).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_APPROVED' });
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 's', 'aramo-ccp-' || $1::text || '-s', $2, 'sign', $3, '{"mode":"IMMEDIATE"}', 'PENDING', 0, $4, now(), now())`,
        [pending.request.id, t, ref, OPS],
      ),
    ).toContain('needs a completed approval chain');
    // A SUBSCRIPTION_END request (an A6 Aramo-owned action) never issues provider commands.
    const t2 = await newTenant(pg);
    const gov = await rawSubscription(pg, t2, { source: 'MANUAL' });
    const end = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_END', tenant_id: t2, product_key: 'sign', payload: { subscription_id: gov }, reason: 'end', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), end.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), end.request.id, { step_index: 0 }, A6_CTX);
    await expect(cancel(end.request.id, t2, 'sub_x')).rejects.toMatchObject({ code: 'ACTION_NOT_COMMAND_ISSUING' });
    // Another tenant's request, and another tenant's subscription.
    // (Q14: tenant t already holds an open request, so the approved one is on a fourth tenant.)
    const other = await selfServiceTenant();
    const t4 = (await selfServiceTenant()).t;
    const cr = await approvedConversion(t4);
    await expect(cancel(cr, other.t, other.ref)).rejects.toMatchObject({ code: 'TENANT_PRODUCT_MISMATCH' });
    await expect(cancel(cr, t4, other.ref)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    // A governed row is never a provider-command target (it is Aramo-owned; A6 G1 mirror).
    const t3 = await newTenant(pg);
    await rawSubscription(pg, t3, { source: 'MANUAL', ref: `sub_manual_${t3}` });
    const cr3 = await approvedConversion(t3);
    await expect(cancel(cr3, t3, `sub_manual_${t3}`)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."BillingProviderCommand" WHERE tenant_id = ANY($1::uuid[])`, [[t, t2, t3, t4, other.t]])).rows[0].n).toBe(0);
  });

  it('C1-ENQ-3 the outbox write is part of the caller transaction: rolled back with it, committed with it', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    await expect(
      prisma.$transaction(async (tx) => {
        await h.commands.enqueue({ change_request_id: cr, step: 'rolled_back', command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: t, product_key: 'sign', target_ref: ref, mode: 'IMMEDIATE', created_by: OPS, at: T0 }, tx);
        throw new Error('caller rolls back');
      }),
    ).rejects.toThrow('caller rolls back');
    expect((await h.commands.forChangeRequest(cr)).length).toBe(0);
    await prisma.$transaction(async (tx) => {
      await h.commands.enqueue({ change_request_id: cr, step: 'committed', command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: t, product_key: 'sign', target_ref: ref, mode: 'IMMEDIATE', created_by: OPS, at: T0 }, tx);
    });
    expect((await h.commands.forChangeRequest(cr)).map((c) => c.step)).toEqual(['committed']);
  });

  // ---- dispatch, pending-provider, confirmation ------------------------------------------------

  it('C1-PEND-1 dispatch → PENDING_PROVIDER; the local subscription is NOT ended and the command NOT confirmed on local commit; the verified webhook applies the end and confirms the command in the same transaction', async () => {
    const { t, ref, sub_id } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    // The queue is shared with earlier tests' commands: assert on this command.
    const tally = await h.commands.dispatchDue(min(1));
    expect(tally.skipped).toBeNull();
    expect(tally.accepted).toBeGreaterThanOrEqual(1);
    expect(h.billing.calls.filter((c) => c.ref === ref && c.op === 'cancelSubscription')).toEqual([{ op: 'cancelSubscription', ref, idempotency_key: `aramo-ccp-${cr}-end_self_service`, at_period_end: false }]);
    // Pending-provider (C-23): the provider has cancelled, Aramo has not applied it.
    expect(await cmd(command.id)).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 1, confirmed_at: null, lease_until: null });
    expect((await sub(sub_id)).ended_at).toBeNull();
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    // A second dispatch pass does nothing (no second provider call).
    await h.commands.dispatchDue(min(2));
    expect(h.billing.count('cancelSubscription', ref)).toBe(1);
    expect((await cmd(command.id)).attempts).toBe(1);
    // The verified webhook, through the inbox.
    const id = evtId();
    expect(await deliver(ref, min(3), id, 'subscription.deleted')).toMatchObject({ outcome: 'APPLIED', detail: 'ACTIVE -> CANCELED' });
    const c = await cmd(command.id);
    const s = await sub(sub_id);
    expect(c).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'WEBHOOK', confirmation_event_id: id });
    expect(s.ended_at).not.toBeNull();
    expect(c.confirmed_at.getTime()).toBe(s.ended_at.getTime());
    expect(c.confirmed_at.getTime()).toBe(min(3).getTime());
    expect(await openRows(t)).toEqual([]);
  });

  it('C1-PEND-2 reconciliation by provider re-fetch confirms a command whose webhook never arrived; AT_PERIOD_END confirms on the schedule, the row stays open until the provider end', async () => {
    const { t, ref, sub_id } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref, 'AT_PERIOD_END');
    await h.commands.dispatchDue(min(1));
    expect((await cmd(command.id)).state).toBe('PENDING_PROVIDER');
    const r = await h.commands.reconcilePending('sign', min(5));
    expect(r.checked).toBeGreaterThanOrEqual(1);
    expect(r.confirmed).toBeGreaterThanOrEqual(1);
    expect(await cmd(command.id)).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'REFETCH', confirmation_event_id: null });
    const s = await sub(sub_id);
    expect(s.cancel_at_period_end).toBe(true);
    expect(s.ended_at).toBeNull();
  });

  it('C1-TX-1 no Stripe call runs inside a local DB transaction: every provider call (reads, cancel, expire; dispatch, re-fetch, inbox) saw 0 backends in a transaction and no locked command row', async () => {
    // Every earlier and later test runs with the probe attached; this one adds a session expire.
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    h.billing.session(t, intent);
    const cr = await approvedConversion(t);
    await h.commands.enqueue({ change_request_id: cr, step: 'expire_session', command_kind: 'CHECKOUT_SESSION_EXPIRE', tenant_id: t, product_key: 'sign', target_ref: `cs_${intent}`, created_by: OPS, at: T0 });
    await h.commands.dispatchDue(min(1));
    await h.commands.reconcilePending('sign', min(2));
    expect(h.billing.probes).toBeGreaterThan(0);
    expect(h.billing.violations).toEqual([]);
  });

  it('C1-SESS-1 CHECKOUT_SESSION_EXPIRE (Conv. C-17 disposition): pending-provider until the checkout.session.expired webhook is applied; then the intent is EXPIRED and the command CONFIRMED', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    h.billing.session(t, intent);
    const cr = await approvedConversion(t);
    const { command } = await h.commands.enqueue({ change_request_id: cr, step: 'expire_session', command_kind: 'CHECKOUT_SESSION_EXPIRE', tenant_id: t, product_key: 'sign', target_ref: `cs_${intent}`, created_by: OPS, at: T0 });
    expect(command.params).toEqual({});
    await h.commands.dispatchDue(min(1));
    expect(h.billing.count('expireCheckoutSession', `cs_${intent}`)).toBe(1);
    expect((await cmd(command.id)).state).toBe('PENDING_PROVIDER');
    expect(await intentStatus(intent)).toBe('CREATED');
    const id = evtId();
    const res = await h.inbox.receive({ id, type: 'checkout.session.expired', created: min(2), subscription_ref: null, checkout_session_ref: `cs_${intent}` }, 'sign', min(2));
    expect(res).toMatchObject({ outcome: 'APPLIED', detail: 'checkout session expired; intent EXPIRED; 1 command(s) confirmed', tenant_id: t });
    expect(await intentStatus(intent)).toBe('EXPIRED');
    expect(await cmd(command.id)).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'WEBHOOK', confirmation_event_id: id });
    expect(await billingEvents(id)).toEqual([{ outcome: 'APPLIED', detail: 'checkout session expired; intent EXPIRED; 1 command(s) confirmed' }]);
  });

  it('C1-SESS-2 a completed session cannot be expired: FAILED SESSION_COMPLETED, no expire call', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    h.billing.session(t, intent, 'complete');
    const cr = await approvedConversion(t);
    const { command } = await h.commands.enqueue({ change_request_id: cr, step: 'expire_session', command_kind: 'CHECKOUT_SESSION_EXPIRE', tenant_id: t, product_key: 'sign', target_ref: `cs_${intent}`, created_by: OPS, at: T0 });
    await h.commands.dispatchDue(min(1));
    expect(await cmd(command.id)).toMatchObject({ state: 'FAILED', last_error_code: 'SESSION_COMPLETED', attempts: 1 });
    expect(h.billing.count('expireCheckoutSession', `cs_${intent}`)).toBe(0);
  });

  // ---- retries and failures ----------------------------------------------------------------

  it('C1-RETRY-1 retry after a transient failure: RETRY_WAIT with backoff, not re-claimed before it is due, then accepted; the SAME idempotency key on every attempt', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    h.billing.failures.set(ref, { kind: 'transient', times: 2 });
    await h.commands.dispatchDue(min(1));
    expect(await cmd(command.id)).toMatchObject({ state: 'RETRY_WAIT', attempts: 1, last_error_code: 'PROVIDER_UNAVAILABLE' });
    expect((await cmd(command.id)).next_attempt_at.getTime()).toBe(min(2).getTime()); // 1 minute after attempt 1
    await h.commands.dispatchDue(new Date(min(2).getTime() - 1)); // not yet due
    expect(await cmd(command.id)).toMatchObject({ state: 'RETRY_WAIT', attempts: 1 });
    await h.commands.dispatchDue(min(2));
    expect(await cmd(command.id)).toMatchObject({ state: 'RETRY_WAIT', attempts: 2 });
    expect((await cmd(command.id)).next_attempt_at.getTime()).toBe(min(4).getTime()); // 2 minutes after attempt 2
    await h.commands.dispatchDue(min(4));
    expect(await cmd(command.id)).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 3, last_error_code: null });
    const keys = h.billing.calls.filter((c) => c.op === 'cancelSubscription' && c.ref === ref).map((c) => c.idempotency_key);
    expect(keys).toEqual([`aramo-ccp-${cr}-end_self_service`, `aramo-ccp-${cr}-end_self_service`, `aramo-ccp-${cr}-end_self_service`]);
  });

  it('C1-FAIL-1 failed commands are visible and never dropped: retries exhausted → FAILED; a provider refusal → FAILED at once; both listed; DELETE refused; an explicit retry re-queues', async () => {
    const a = await selfServiceTenant();
    const crA = await approvedConversion(a.t);
    const ca = (await cancel(crA, a.t, a.ref)).command;
    h.billing.failures.set(a.ref, { kind: 'transient', times: 100 });
    let at = min(1);
    for (let i = 0; i < BILLING_COMMAND_MAX_ATTEMPTS; i += 1) {
      await h.commands.dispatchDue(at);
      at = new Date(at.getTime() + 7 * 60 * 60_000); // past any backoff
    }
    expect(await cmd(ca.id)).toMatchObject({ state: 'FAILED', attempts: BILLING_COMMAND_MAX_ATTEMPTS, last_error_code: 'RETRIES_EXHAUSTED' });
    expect(h.billing.count('cancelSubscription', a.ref)).toBe(BILLING_COMMAND_MAX_ATTEMPTS);

    const b = await selfServiceTenant();
    const crB = await approvedConversion(b.t);
    const cb = (await cancel(crB, b.t, b.ref)).command;
    h.billing.failures.set(b.ref, { kind: 'refused', times: 1 });
    await h.commands.dispatchDue(min(1));
    expect(await cmd(cb.id)).toMatchObject({ state: 'FAILED', attempts: 1, last_error_code: 'PROVIDER_REFUSED' });

    const failed = await h.commands.list({ state: 'FAILED' });
    expect(failed.commands.map((c) => c.id)).toEqual(expect.arrayContaining([ca.id, cb.id]));
    expect(await dbError(`DELETE FROM subscription."BillingProviderCommand" WHERE id = $1`, [cb.id])).toContain('never deleted');
    // A FAILED command is not re-dispatched automatically …
    await h.commands.dispatchDue(min(2));
    expect(await cmd(cb.id)).toMatchObject({ state: 'FAILED', attempts: 1 });
    // … until an explicit retry: FAILED → PENDING (attempts kept), then accepted.
    expect(await h.commands.retryFailed(cb.id, min(3))).toMatchObject({ state: 'PENDING', attempts: 1 });
    await expect(h.commands.retryFailed(cb.id, min(3))).rejects.toMatchObject({ code: 'NOT_FAILED' });
    await h.commands.dispatchDue(min(3));
    expect(await cmd(cb.id)).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 2 });
  });

  it('C1-FAIL-2 the provider object of another tenant is never acted on: TENANT_MISMATCH, FAILED, no cancel call', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    h.billing.subs.set(ref, { ...h.billing.subs.get(ref)!, tenant_id: randomUUID() });
    await h.commands.dispatchDue(min(1));
    expect(await cmd(command.id)).toMatchObject({ state: 'FAILED', last_error_code: 'TENANT_MISMATCH' });
    expect(h.billing.count('cancelSubscription', ref)).toBe(0);
  });

  it('C1-LEASE-1 a dispatcher that dies mid-call: the command is not re-claimed while its lease runs, then re-claimed (attempt counted); the stale outcome loses the fence', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    // Simulate the crashed claim: PENDING → DISPATCHING, attempt 1, lease to T0 + 5 min.
    await pg.query(`UPDATE subscription."BillingProviderCommand" SET state = 'DISPATCHING', attempts = 1, lease_until = $2, updated_at = $3 WHERE id = $1`, [command.id, min(5), T0]);
    await h.commands.dispatchDue(min(4));
    expect(await cmd(command.id)).toMatchObject({ state: 'DISPATCHING', attempts: 1 });
    await h.commands.dispatchDue(min(5));
    expect(await cmd(command.id)).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 2 });
    // The crashed attempt's late outcome (fenced on attempts = 1) changes nothing.
    const late = await prisma.billingProviderCommand.updateMany({ where: { id: command.id, state: 'DISPATCHING', attempts: 1 }, data: { state: 'FAILED', failed_at: min(6), last_error_code: 'X', updated_at: min(6) } });
    expect(late.count).toBe(0);
  });

  it('C1-SM-DB the DB state machine: illegal transitions, identity edits and inserts outside PENDING are refused; CONFIRMED is terminal', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    const upd = (set: string) => dbError(`UPDATE subscription."BillingProviderCommand" SET ${set} WHERE id = $1`, [command.id]);
    expect(await upd(`state = 'PENDING_PROVIDER'`)).toContain('transition PENDING -> PENDING_PROVIDER refused');
    expect(await upd(`state = 'DISPATCHING', attempts = 5, lease_until = now()`)).toContain('refused');
    expect(await upd(`target_ref = 'sub_other'`)).toContain('immutable');
    expect(await upd(`params = '{"mode":"AT_PERIOD_END"}'`)).toContain('immutable');
    expect(await upd(`state = 'CONFIRMED', confirmed_at = now(), confirmation_source = 'WEBHOOK'`)).toBe('OK');
    expect(await upd(`state = 'PENDING'`)).toContain('CONFIRMED (terminal)');
    const cr2 = await approvedConversion((await selfServiceTenant()).t);
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), 'STRIPE', 'CHECKOUT_SESSION_EXPIRE', id, 's', 'aramo-ccp-' || id || '-s', tenant_id, 'sign', 'cs_x', '{}', 'PENDING_PROVIDER', 0, $2, now(), now() FROM subscription."CommercialChangeRequest" WHERE id = $1`,
        [cr2, OPS],
      ),
    ).toContain('starts PENDING');
  });

  it('C1-LIVE-1 production hold: with a live-mode provider key nothing is dispatched; the command stays PENDING (visible)', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    h.billing.liveMode = true;
    try {
      expect(await h.commands.dispatchDue(min(1))).toMatchObject({ skipped: 'LIVE_MODE', claimed: 0 });
    } finally {
      h.billing.liveMode = false;
    }
    expect(await cmd(command.id)).toMatchObject({ state: 'PENDING', attempts: 0 });
    expect(h.billing.count('cancelSubscription', ref)).toBe(0);
    await h.commands.dispatchDue(min(1)); // drain it so later tests start clean
  });

  // ---- the webhook inbox ---------------------------------------------------------------------

  it('C1-INBOX-1 a duplicate delivery is idempotent: DUPLICATE, one inbox row (attempts 1), one BillingEvent, no second re-fetch', async () => {
    const { ref, sub_id } = await selfServiceTenant();
    const id = evtId();
    const before = h.billing.count('retrieveSubscription', ref);
    expect((await deliver(ref, min(1), id)).outcome).toBe('APPLIED');
    const row1 = await rowJson(sub_id);
    expect(await deliver(ref, min(2), id)).toEqual({ outcome: 'DUPLICATE', tenant_id: null });
    expect(await inboxRow(id)).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', attempts: 1 });
    expect((await billingEvents(id)).length).toBe(1);
    expect(h.billing.count('retrieveSubscription', ref)).toBe(before + 1);
    expect(await rowJson(sub_id)).toBe(row1);
  });

  it('C1-INBOX-2 concurrent duplicate deliveries: exactly one processes; one SELF_SERVICE row, one BillingEvent, intent COMPLETED once', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    const s = h.billing.state(t, intent);
    const id = evtId();
    h.billing.attachProbe(null); // concurrent applies legitimately overlap here
    let results;
    try {
      results = await Promise.all(Array.from({ length: 5 }, () => deliver(s.subscription_ref, min(1), id, 'checkout.session.completed')));
    } finally {
      h.billing.attachProbe(probe);
    }
    expect(results.filter((r) => r.outcome === 'APPLIED').length).toBe(1);
    expect(results.filter((r) => r.outcome === 'DUPLICATE').length).toBe(4);
    expect(await openRows(t)).toEqual(['SELF_SERVICE']);
    expect((await billingEvents(id)).length).toBe(1);
    expect(await intentStatus(intent)).toBe('COMPLETED');
    expect(await inboxRow(id)).toMatchObject({ status: 'PROCESSED', attempts: 1 });
  });

  it('C1-INBOX-3 out-of-order deliveries: the newer state applied first is never regressed by an older event (re-fetch); an ended row is never reopened; the command is confirmed once', async () => {
    const { t, ref, sub_id } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, ref);
    await h.commands.dispatchDue(min(1)); // provider now: canceled
    const newer = evtId();
    const older = evtId();
    expect(await deliver(ref, min(3), newer, 'subscription.deleted', min(2))).toMatchObject({ outcome: 'APPLIED', detail: 'ACTIVE -> CANCELED' });
    const confirmedAt = (await cmd(command.id)).confirmed_at.getTime();
    const ended = await rowJson(sub_id);
    // The older event (created earlier at the provider) arrives later.
    expect(await deliver(ref, min(4), older, 'subscription.updated', T0)).toMatchObject({ outcome: 'IGNORED', detail: 'subscription already ended' });
    expect(await rowJson(sub_id)).toBe(ended);
    expect(await openRows(t)).toEqual([]);
    expect(await cmd(command.id)).toMatchObject({ state: 'CONFIRMED', confirmation_event_id: newer });
    expect((await cmd(command.id)).confirmed_at.getTime()).toBe(confirmedAt);
    // State-changing reorder: past_due (newer) applied first, the older 'active' event re-fetches
    // the CURRENT provider state and cannot regress it.
    const p = await selfServiceTenant();
    h.billing.subs.set(p.ref, { ...h.billing.subs.get(p.ref)!, provider_status: 'past_due' });
    expect(await deliver(p.ref, min(5), evtId(), 'invoice.payment_failed', min(5))).toMatchObject({ outcome: 'APPLIED', detail: 'ACTIVE -> PAST_DUE' });
    expect(await deliver(p.ref, min(6), evtId(), 'invoice.paid', T0)).toMatchObject({ outcome: 'APPLIED', detail: 'PAST_DUE -> PAST_DUE' });
    expect((await sub(p.sub_id)).status).toBe('PAST_DUE');
  });

  it('C1-INBOX-4 a processing failure is recorded FAILED (and rethrown for redelivery); nothing is dropped; a redelivery or the drain processes it', async () => {
    const { ref } = await selfServiceTenant();
    const saved = h.billing.subs.get(ref)!;
    h.billing.subs.delete(ref); // the re-fetch fails (provider unavailable)
    const id = evtId();
    await expect(deliver(ref, min(1), id)).rejects.toThrow(/no such subscription/);
    expect(await inboxRow(id)).toMatchObject({ status: 'FAILED', attempts: 1, outcome: null, last_error: expect.stringContaining('no such subscription') });
    expect((await inboxRow(id)).next_attempt_at.getTime()).toBe(min(2).getTime());
    expect(await billingEvents(id)).toEqual([]);
    const listed = await h.inbox.list({ status: 'FAILED' });
    expect(listed.events.map((e) => e.provider_event_id)).toContain(id);
    h.billing.subs.set(ref, saved);
    // The drain does not take it before its backoff …
    await h.inbox.drain('sign', new Date(min(2).getTime() - 1));
    expect(await inboxRow(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    // … and processes it once due.
    const d = await h.inbox.drain('sign', min(2));
    expect(d.processed).toBeGreaterThanOrEqual(1);
    expect(await inboxRow(id)).toMatchObject({ status: 'PROCESSED', outcome: 'APPLIED', attempts: 2 });
    // A provider redelivery after that is a DUPLICATE.
    expect((await deliver(ref, min(3), id)).outcome).toBe('DUPLICATE');
  });

  it('C1-INBOX-5 crash recovery: a RECEIVED row (crash between receipt and processing) and an expired PROCESSING lease are drained; PROCESSED is terminal and DELETE refused', async () => {
    const { ref } = await selfServiceTenant();
    const a = evtId();
    const b = evtId();
    for (const id of [a, b]) {
      await pg.query(
        `INSERT INTO subscription."BillingWebhookInbox" (id, provider, provider_event_id, event_type, event_created_at, subscription_ref, product_key, status, attempts, received_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', $1, 'subscription.updated', $2, $3, 'sign', 'RECEIVED', 0, $2, $2)`,
        [id, T0, ref],
      );
    }
    await pg.query(`UPDATE subscription."BillingWebhookInbox" SET status = 'PROCESSING', attempts = 1, lease_until = $2, updated_at = $3 WHERE provider_event_id = $1`, [b, min(5), T0]);
    const d1 = await h.inbox.drain('sign', min(1));
    expect(d1.processed).toBeGreaterThanOrEqual(1);
    expect((await inboxRow(a)).status).toBe('PROCESSED');
    expect((await inboxRow(b)).status).toBe('PROCESSING'); // lease still live
    await h.inbox.drain('sign', min(5));
    expect(await inboxRow(b)).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    expect(await dbError(`UPDATE subscription."BillingWebhookInbox" SET status = 'FAILED', last_error = 'x' WHERE provider_event_id = $1`, [a])).toContain('PROCESSED (terminal)');
    expect(await dbError(`UPDATE subscription."BillingWebhookInbox" SET subscription_ref = 'sub_other' WHERE provider_event_id = $1`, [b])).toContain('immutable');
    expect(await dbError(`DELETE FROM subscription."BillingWebhookInbox" WHERE provider_event_id = $1`, [a])).toContain('never deleted');
  });

  // ---- A6's hold through the inbox --------------------------------------------------------------

  it('C1-HOLD-1 a held activation (Conv. C-6/C-7) still holds through the inbox: IGNORED with the hold named, flag open, intent CREATED, governed row byte-identical; a redelivery is a DUPLICATE and the drain changes nothing', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    const gov = await rawSubscription(pg, t, { source: 'MANUAL' });
    const before = await rowJson(gov);
    const s = h.billing.state(t, intent);
    const id = evtId();
    const res = await deliver(s.subscription_ref, min(1), id, 'checkout.session.completed');
    expect(res).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open: held for reconciliation') });
    expect(await inboxRow(id)).toMatchObject({ status: 'PROCESSED', outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open') });
    expect(await billingEvents(id)).toEqual([{ outcome: 'IGNORED', detail: expect.stringContaining('governed_subscription_open') }]);
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await intentStatus(intent)).toBe('CREATED');
    expect(await rowJson(gov)).toBe(before);
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect((await deliver(s.subscription_ref, min(2), id, 'checkout.session.completed')).outcome).toBe('DUPLICATE');
    await h.inbox.drain('sign', min(60));
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    expect(await intentStatus(intent)).toBe('CREATED');
    expect(await rowJson(gov)).toBe(before);
    expect(await openRows(t)).toEqual(['MANUAL']);
  });

  it('C1-HOLD-2 a held activation whose provider subscription is cancelled by a durable command: the flag stays open while pending-provider; the webhook-confirmed end resolves it (C-9) and confirms the command; the governed row is untouched and no SELF_SERVICE row opens', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    const gov = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED });
    const before = await rowJson(gov);
    const s = h.billing.state(t, intent);
    await deliver(s.subscription_ref, min(1), evtId(), 'checkout.session.completed');
    expect(await openFlags(t)).toEqual(['governed_subscription_open']);
    const cr = await approvedConversion(t);
    const { command } = await cancel(cr, t, s.subscription_ref, 'IMMEDIATE', 'cancel_held_activation');
    await h.commands.dispatchDue(min(2));
    expect((await cmd(command.id)).state).toBe('PENDING_PROVIDER');
    expect(await openFlags(t)).toEqual(['governed_subscription_open']); // not resolved on local commit
    const id = evtId();
    expect(await deliver(s.subscription_ref, min(3), id, 'subscription.deleted')).toMatchObject({ outcome: 'IGNORED', detail: 'checkout subscription already ended' });
    expect(await openFlags(t)).toEqual([]);
    expect(await cmd(command.id)).toMatchObject({ state: 'CONFIRMED', confirmation_event_id: id });
    expect(await rowJson(gov)).toBe(before);
    expect(await openRows(t)).toEqual(['MANUAL']);
    expect(await intentStatus(intent)).toBe('CREATED');
    void (await publishedVersion(pg, INCLUDED));
  });

  // ---- operator read ---------------------------------------------------------------------------

  it('C1-LIST-1 the operator list: newest first, filters (state, tenant, change request), keyset cursor pinned to the filters', async () => {
    const { t, ref } = await selfServiceTenant();
    const cr = await approvedConversion(t);
    await cancel(cr, t, ref, 'IMMEDIATE', 'step_a');
    await h.commands.enqueue({ change_request_id: cr, step: 'step_b', command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: t, product_key: 'sign', target_ref: ref, mode: 'AT_PERIOD_END', created_by: OPS, at: min(1) });
    const p1 = await h.commands.list({ tenant_id: t, limit: 1 });
    expect(p1.commands.map((c) => c.step)).toEqual(['step_b']);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await h.commands.list({ tenant_id: t, limit: 1, cursor: p1.next_cursor! });
    expect(p2).toMatchObject({ next_cursor: null });
    expect(p2.commands.map((c) => c.step)).toEqual(['step_a']);
    expect((await h.commands.list({ change_request_id: cr })).commands.length).toBe(2);
    await expect(h.commands.list({ tenant_id: randomUUID(), cursor: p1.next_cursor! })).rejects.toBeInstanceOf(BillingCommandError);
  });

  it('C1-TX-2 (final) across the whole spec, every provider call ran with no local transaction open', () => {
    expect(h.billing.probes).toBeGreaterThan(40);
    expect(h.billing.violations).toEqual([]);
  });
});
