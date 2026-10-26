import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SELF_SERVICE_PRODUCTS, SelfServiceBillingService, SelfServiceRefusedError } from '../lib/billing/self-service-billing.service.js';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion, legalRef } from '../lib/legal/legal-documents.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PRODUCT_KEYS } from '../lib/product-registry.js';

import { publishTestPlanV1, publishedVersionOf } from './fixtures/ccp-a5.js';
import { ISOLATION_TEST_PRODUCT_KEY, registerIsolationTestProduct } from './fixtures/ccp-a4.js';
import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, newTenant, publishedVersion, rawSubscription } from './support/ccp-a6.js';
import { type C2Harness, c2Harness } from './support/ccp-c2.js';

// CCP-C7 (PBD §5.2 row C7, §10; Charter :95, :99; Conversion Rule C-15, C-22, C-23; MP-A2 N-12;
// decisions DR-C2-1, TD-C1-2, T8) — tenant self-service visibility and the owner's cancel / upgrade
// on real Postgres 17 with the real lifecycle, command, inbox, change-request and conversion
// services; Stripe is a fake (no network, no key). Test IDs are cited by
// doc/ccp/slices/CCP-C7-acceptance.md:
//   C7-TERMS-*  the legal-terms designed disabled state (the shipped registry: Sign ToS DRAFT)
//   C7-CMD-*    durable-command execution in Stripe TEST mode (approved terms injected, test only)
//   C7-HOLD-*   the A6 governed-subscription hold and the held activation
//   C7-C2-*     interplay with the C2 conversion (in progress refuses; completion confirms both)
//   C7-FIN-*    DR-C2-1 commitment term and DR-C7-1 price change (fail closed, nothing written)
//   C7-ISO-*    MP-A2 N-12 per-product isolation (real registry + the test-database-only key)
//   C7-DB-*     DB backstops (request trigger, command origin, derived keys, immutability)
//   C7-TX-1     no provider call inside a local transaction

const T0 = new Date('2026-10-25T12:00:00.000Z');
const H = 3_600_000;
const GOV_PLAN = 'aramo-sign-c7-test-governed';
const GOV_PLAN_ID = '019a0000-5150-7000-8000-0000000c7001';
const ISO = ISOLATION_TEST_PRODUCT_KEY;
const ISO_PLAN = '019a0000-5150-7000-8000-0000000c7002';

/** TEST ONLY — the shipped Sign ToS entry marked APPROVED, to exercise the path behind the gate. */
const APPROVED_TERMS: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS.map((d) =>
  d.key === 'sign.terms_of_service' ? { ...d, status: 'APPROVED' as const, url: 'https://sign.test/legal/terms/0.1.1', effective_from: '2026-01-01T00:00:00Z' } : d,
);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C7 multi-product self-service (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let probe: Client;
  let prisma: PrismaService;
  let h: C2Harness;
  /** The shipped wiring: the real legal registry (Sign ToS DRAFT). */
  let shipped: SelfServiceBillingService;
  /** Test only: approved terms injected. */
  let approved: SelfServiceBillingService;
  let OPS: string;
  let FA: string;
  let now = T0;
  let keyN = 0;
  let evtN = 0;
  const key = () => `c7-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_c7_${String(++evtN).padStart(6, '0')}`;
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
    h = c2Harness(prisma, () => now);
    h.billing.attachProbe(probe);
    shipped = new SelfServiceBillingService(prisma, h.commands, h.lifecycle);
    approved = new SelfServiceBillingService(prisma, h.commands, h.lifecycle, APPROVED_TERMS);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    // The governed target of a self-service → governed conversion (as C2: equal terms, no commitment).
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'C7 governed test', false, description, tenant_kind, 'CONTACT_SALES', 'ACTIVE', 952, product_key FROM subscription."Plan" WHERE key = $3`,
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
  const requestsOf = async (t: string) => (await pg.query(`SELECT * FROM subscription."SelfServiceBillingRequest" WHERE tenant_id = $1 ORDER BY created_at, id`, [t])).rows;
  const commandsOfTenant = async (t: string) => (await pg.query(`SELECT * FROM subscription."BillingProviderCommand" WHERE tenant_id = $1 ORDER BY created_at, id`, [t])).rows;
  const deliver = (ref: string, at: Date = now, id: string = evtId()) => h.inbox.receive({ id, type: 'subscription.updated', created: at, subscription_ref: ref }, 'sign', at);
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
      if (e instanceof SelfServiceRefusedError) return e.reason;
      throw e;
    }
  }
  /** A BUSINESS tenant with an open Stripe-owned SELF_SERVICE row (no commitment); the fake holds its provider state. */
  async function selfServiceTenant(o: { commitment_end?: string; period_end?: string } = {}): Promise<{ t: string; ss: string; ref: string }> {
    const t = await newTenant(pg);
    const s = h.billing.state(t, randomUUID());
    const ss = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    await pg.query(`UPDATE subscription."TenantSubscription" SET current_period_end = $2::timestamptz, commitment_end = $3::timestamptz WHERE id = $1`, [
      ss,
      o.period_end ?? '2026-11-25T00:00:00Z',
      o.commitment_end ?? null,
    ]);
    return { t, ss, ref: s.subscription_ref };
  }
  const cancelAs = (svc: SelfServiceBillingService, t: string, user = 'owner-1') => svc.cancel({ tenant_id: t, product_key: 'sign', user_id: randomUUIDFor(user), at: now });
  const users = new Map<string, string>();
  function randomUUIDFor(name: string): string {
    if (!users.has(name)) users.set(name, randomUUID());
    return users.get(name) as string;
  }
  /** An APPROVED CONVERSION (Finance-only chain). */
  async function conversion(t: string, payload: Record<string, unknown>): Promise<string> {
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload, reason: 'c7 conversion', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return r.request.id;
  }
  const toGoverned = async (ss: string) => ({ direction: 'TO_GOVERNED', subscription_id: ss, plan_key: GOV_PLAN, plan_version_id: await publishedVersion(pg, GOV_PLAN) });
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

  // ---- the legal-terms designed disabled state ----------------------------------------------

  it('C7-TERMS-1 shipped registry (Sign ToS DRAFT): the view shows NOT_APPROVED and every action unavailable with SELF_SERVICE_TERMS_NOT_APPROVED; cancel and upgrade are refused with that code; nothing is written and Stripe is never called', async () => {
    now = T0;
    const { t, ss, ref } = await selfServiceTenant();
    const before = await rowJson(ss);
    const calls = h.billing.calls.length;
    const v = await shipped.view(t, 'sign');
    expect(v.terms).toEqual({ state: 'NOT_APPROVED', document_key: 'sign.terms_of_service', version: null, url: null });
    expect(v.actions).toEqual({
      cancel: { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' },
      upgrade: { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' },
    });
    expect(v.subscription).toMatchObject({ plan_key: BUSINESS, cancel_at_period_end: false });
    expect(v.pending_provider).toBe(false);
    expect(await refusal(cancelAs(shipped, t))).toBe('SELF_SERVICE_TERMS_NOT_APPROVED');
    expect(await refusal(shipped.upgrade({ tenant_id: t, product_key: 'sign', plan_key: 'aramo-sign-standard-professional-v1' }))).toBe('SELF_SERVICE_TERMS_NOT_APPROVED');
    expect(await requestsOf(t)).toEqual([]);
    expect(await commandsOfTenant(t)).toEqual([]);
    expect(await rowJson(ss)).toBe(before);
    expect(h.billing.calls.length).toBe(calls);
    expect(h.billing.count('cancelSubscription', ref)).toBe(0);
  });

  it('C7-TERMS-2 the gate precedes every other gate (a governed tenant still reads the terms state first) and the request row cannot be recorded without an approved-terms reference', async () => {
    const { t } = await governedTenant();
    expect(await refusal(cancelAs(shipped, t))).toBe('SELF_SERVICE_TERMS_NOT_APPROVED');
    expect((await shipped.view(t, 'sign')).actions.cancel.reason).toBe('SELF_SERVICE_TERMS_NOT_APPROVED');
    const { t: t2, ss, ref } = await selfServiceTenant();
    expect(
      await dbError(
        `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
         VALUES (gen_random_uuid(), $1, 'sign', 'CANCEL_AT_PERIOD_END', $2, 'STRIPE', $3, 'not approved', gen_random_uuid(), now())`,
        [t2, ss, ref],
      ),
    ).toMatch(/SelfServiceBillingRequest_terms_ref_check/);
  });

  // ---- durable-command execution in Stripe TEST mode ------------------------------------------

  it('C7-CMD-1 cancel (approved terms, TEST mode): one locked transaction records the request and the C1 command (AT_PERIOD_END, key derived from the request); pending-provider on local commit, after dispatch, and until the applied provider state confirms it', async () => {
    now = T0;
    const { t, ss, ref } = await selfServiceTenant();
    const before = await rowJson(ss);
    const r = await cancelAs(approved, t);
    expect(r).toMatchObject({ action: 'CANCEL_AT_PERIOD_END', status: 'PENDING_PROVIDER', pending_provider: true, replayed: false });
    const [req] = await requestsOf(t);
    expect(req).toMatchObject({ id: r.request_id, product_key: 'sign', action: 'CANCEL_AT_PERIOD_END', subscription_id: ss, provider: 'STRIPE', target_ref: ref });
    expect(req.terms_ref).toBe(legalRef(APPROVED_TERMS.find((d) => d.key === 'sign.terms_of_service')!));
    const cmds = await commandsOfTenant(t);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      change_request_id: null,
      self_service_request_id: r.request_id,
      command_kind: 'SUBSCRIPTION_CANCEL',
      step: 'cancel_at_period_end',
      idempotency_key: `aramo-ccp-ss-${r.request_id}-cancel_at_period_end`,
      params: { mode: 'AT_PERIOD_END' },
      state: 'PENDING',
      attempts: 0,
      target_ref: ref,
    });
    expect(await rowJson(ss)).toBe(before); // nothing local implies Stripe changed (C-23)
    let v = await approved.view(t, 'sign');
    expect(v.pending_provider).toBe(true);
    expect(v.pending_changes).toEqual([{ action: 'CANCEL_AT_PERIOD_END', state: 'PENDING_PROVIDER', requested_at: T0, confirmed_at: null }]);
    expect(v.actions.cancel).toEqual({ available: false, reason: 'PROVIDER_CHANGE_PENDING' });

    // Replay: the recorded request, no second command.
    expect(await cancelAs(approved, t)).toMatchObject({ request_id: r.request_id, replayed: true, status: 'PENDING_PROVIDER' });
    expect(await commandsOfTenant(t)).toHaveLength(1);

    // Dispatch (test mode): the provider accepts; still pending (accepted ≠ confirmed).
    now = new Date(T0.getTime() + 60_000);
    const tally = await h.commands.dispatchDue(now);
    expect(tally.skipped).toBeNull();
    expect((await commandsOfTenant(t))[0]).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 1 });
    expect(h.billing.calls.filter((c) => c.op === 'cancelSubscription' && c.ref === ref)).toEqual([
      { op: 'cancelSubscription', ref, idempotency_key: `aramo-ccp-ss-${r.request_id}-cancel_at_period_end`, at_period_end: true },
    ]);
    expect((await sub(ss)).cancel_at_period_end).toBe(false);
    expect((await approved.view(t, 'sign')).pending_provider).toBe(true);

    // The verified webhook through the inbox applies the provider state and confirms the command in that transaction.
    now = new Date(T0.getTime() + H);
    const evt = evtId();
    expect(await deliver(ref, now, evt)).toMatchObject({ outcome: 'APPLIED' });
    expect((await commandsOfTenant(t))[0]).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'WEBHOOK', confirmation_event_id: evt });
    const after = await sub(ss);
    expect(after).toMatchObject({ cancel_at_period_end: true, ended_at: null, source: 'SELF_SERVICE' });
    v = await approved.view(t, 'sign');
    expect(v.pending_provider).toBe(false);
    expect(v.pending_changes[0]).toMatchObject({ state: 'CONFIRMED' });
    expect(v.actions.cancel).toEqual({ available: false, reason: 'ALREADY_CANCELING' });
    expect(await cancelAs(approved, t)).toMatchObject({ replayed: true, status: 'CONFIRMED', pending_provider: false });
  });

  it('C7-CMD-2 reconciliation by re-fetch confirms a self-service command whose webhook never arrived; a live-mode key dispatches nothing (commands stay PENDING, visible)', async () => {
    now = T0;
    const a = await selfServiceTenant();
    await cancelAs(approved, a.t);
    h.billing.liveMode = true;
    try {
      const live = await h.commands.dispatchDue(now);
      expect(live.skipped).toBe('LIVE_MODE');
      expect((await commandsOfTenant(a.t))[0]).toMatchObject({ state: 'PENDING', attempts: 0 });
      expect(h.billing.count('cancelSubscription', a.ref)).toBe(0);
    } finally {
      h.billing.liveMode = false;
    }
    await h.commands.dispatchDue(now);
    expect((await commandsOfTenant(a.t))[0].state).toBe('PENDING_PROVIDER');
    await h.commands.reconcilePending('sign', new Date(T0.getTime() + 5 * 60_000));
    expect((await commandsOfTenant(a.t))[0]).toMatchObject({ state: 'CONFIRMED', confirmation_source: 'REFETCH' });
    expect((await sub(a.ss)).cancel_at_period_end).toBe(true);
  });

  it('C7-CMD-3 a transient provider failure retries with the SAME derived key; a provider refusal is FAILED and surfaced (pending, never dropped), and the view keeps reporting it pending', async () => {
    now = T0;
    const a = await selfServiceTenant();
    const r = await cancelAs(approved, a.t);
    h.billing.failures.set(a.ref, { kind: 'transient', times: 1 });
    await h.commands.dispatchDue(now);
    expect((await commandsOfTenant(a.t))[0]).toMatchObject({ state: 'RETRY_WAIT', attempts: 1 });
    await h.commands.dispatchDue(new Date(T0.getTime() + 2 * 60_000));
    expect((await commandsOfTenant(a.t))[0]).toMatchObject({ state: 'PENDING_PROVIDER', attempts: 2 });
    const keys = h.billing.calls.filter((c) => c.op === 'cancelSubscription' && c.ref === a.ref).map((c) => c.idempotency_key);
    expect(keys).toEqual([`aramo-ccp-ss-${r.request_id}-cancel_at_period_end`, `aramo-ccp-ss-${r.request_id}-cancel_at_period_end`]);

    const b = await selfServiceTenant();
    await cancelAs(approved, b.t);
    h.billing.failures.set(b.ref, { kind: 'refused', times: 1 });
    await h.commands.dispatchDue(now);
    expect((await commandsOfTenant(b.t))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'PROVIDER_REFUSED' });
    expect((await h.commands.list({ state: 'FAILED', tenant_id: b.t })).commands).toHaveLength(1);
    expect((await approved.view(b.t, 'sign')).pending_provider).toBe(true);
    expect(await dbError(`DELETE FROM subscription."BillingProviderCommand" WHERE tenant_id = $1`, [b.t])).toMatch(/never deleted/);
  });

  // ---- A6 hold and C2 interplay --------------------------------------------------------------

  it('C7-HOLD-1 a governed (MANUAL) subscription is never acted on: GOVERNED_SUBSCRIPTION_OPEN for cancel, upgrade and the view; the governed row is byte-identical; the DB refuses a request while a governed row is open', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const before = await rowJson(gov);
    expect(await refusal(cancelAs(approved, t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect(await refusal(approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: BUSINESS }))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    expect((await approved.view(t, 'sign')).actions).toEqual({
      cancel: { available: false, reason: 'GOVERNED_SUBSCRIPTION_OPEN' },
      upgrade: { available: false, reason: 'GOVERNED_SUBSCRIPTION_OPEN' },
    });
    expect(await rowJson(gov)).toBe(before);
    expect(await requestsOf(t)).toEqual([]);
    expect(
      await dbError(
        `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
         VALUES (gen_random_uuid(), $1, 'sign', 'CANCEL_AT_PERIOD_END', $2, 'STRIPE', 'sub_x', $3, gen_random_uuid(), now())`,
        [t, gov, legalRef(APPROVED_TERMS[0]!)],
      ),
    ).toMatch(/not an open provider-linked SELF_SERVICE base row/);
  });

  it('C7-HOLD-2 a held activation (A6 hold, C-7): the governed row stays authoritative; self-service actions are refused and no command is written; the tenant view reveals no flag or reason', async () => {
    now = T0;
    const { t, gov } = await governedTenant();
    const intent = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [intent, t, `cs_${intent}`, '2026-10-20T09:00:00.000Z', BUSINESS],
    );
    const s = h.billing.state(t, intent);
    expect(await deliver(s.subscription_ref)).toMatchObject({ outcome: 'IGNORED' });
    expect(await h.lifecycle.tenantActivationState(t, 'sign')).not.toBeNull();
    const before = await rowJson(gov);
    expect(await refusal(cancelAs(approved, t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
    const v = await approved.view(t, 'sign');
    expect(v.actions.cancel.available).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/governed_subscription_open|reconciliation|flag/);
    expect(await commandsOfTenant(t)).toEqual([]);
    expect(await rowJson(gov)).toBe(before);
    // The held provider subscription is not this tenant's SELF_SERVICE row: the C7 origin can never target it.
    const req = randomUUID();
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, self_service_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 'cancel_at_period_end', 'aramo-ccp-ss-' || $1::text || '-cancel_at_period_end', $2::uuid, 'sign', $3, '{"mode":"AT_PERIOD_END"}', 'PENDING', 0, gen_random_uuid(), now(), now())`,
        [req, t, s.subscription_ref],
      ),
    ).toMatch(/self-service request .* not found|BillingProviderCommand_self_service_request_id_fkey/);
  });

  it('C7-C2-1 an open CONVERSION change request refuses every self-service action (CONVERSION_IN_PROGRESS), from DRAFT through APPLYING; nothing is written', async () => {
    now = T0;
    const { t, ss } = await selfServiceTenant();
    const draft = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: await toGoverned(ss), reason: 'c7 draft', idempotency_key: key() }, A6_CTX);
    expect(await refusal(cancelAs(approved, t))).toBe('CONVERSION_IN_PROGRESS');
    expect((await approved.view(t, 'sign')).actions.cancel.reason).toBe('CONVERSION_IN_PROGRESS');
    await h.changeRequests.withdraw(as(OPS, 'commercial_ops'), draft.request.id, A6_CTX);
    expect((await approved.view(t, 'sign')).actions.cancel).toEqual({ available: true, reason: null });
    const cr = await conversion(t, await toGoverned(ss));
    expect(await refusal(cancelAs(approved, t))).toBe('CONVERSION_IN_PROGRESS');
    await h.conversions.apply(as(OPS, 'commercial_ops'), cr, A6_CTX); // APPLYING, pending provider
    expect(await refusal(cancelAs(approved, t))).toBe('CONVERSION_IN_PROGRESS');
    expect(await requestsOf(t)).toEqual([]);
  });

  it('C7-C2-2 a pending self-service cancel, then a governed self-service → governed conversion: the provider-confirmed end confirms BOTH commands in the applying transaction, the conversion completes (governed row opens) and the self-service command is never treated as a change request', async () => {
    now = T0;
    const { t, ss, ref } = await selfServiceTenant();
    await cancelAs(approved, t);
    await h.commands.dispatchDue(now);
    // C2's own pre-provider check refuses while a provider change is in flight? It is not C7's to
    // decide; the conversion is applied as C2 built it and C7 only must not break its completion.
    const cr = await conversion(t, await toGoverned(ss));
    const applied = await h.conversions.apply(as(OPS, 'commercial_ops'), cr, A6_CTX);
    expect(applied).toMatchObject({ status: 'PENDING_PROVIDER' });
    await h.commands.dispatchDue(new Date(T0.getTime() + 60_000));
    now = new Date(T0.getTime() + H);
    expect(await deliver(ref, now)).toMatchObject({ outcome: 'APPLIED' });
    const cmds = await commandsOfTenant(t);
    expect(cmds.map((c) => [c.change_request_id === null ? 'self-service' : 'change-request', c.state])).toEqual([
      ['self-service', 'CONFIRMED'],
      ['change-request', 'CONFIRMED'],
    ]);
    expect((await one(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [cr])).state).toBe('APPLIED');
    expect(await openRows(t)).toEqual(['MANUAL']);
    // Now governed: no further self-service action.
    expect(await refusal(cancelAs(approved, t))).toBe('GOVERNED_SUBSCRIPTION_OPEN');
  });

  // ---- financial treatment (fail closed) -------------------------------------------------------

  it('C7-FIN-1 DR-C2-1: inside a commitment term the cancel is refused FINANCIAL_TREATMENT_UNDEFINED (no early cancellation); at the commitment end (the last period) a non-renewal cancel is admitted', async () => {
    now = T0;
    const inside = await selfServiceTenant({ commitment_end: '2027-10-01T00:00:00Z', period_end: '2026-11-25T00:00:00Z' });
    expect(await refusal(cancelAs(approved, inside.t))).toBe('FINANCIAL_TREATMENT_UNDEFINED');
    expect(await requestsOf(inside.t)).toEqual([]);
    expect((await approved.view(inside.t, 'sign')).actions.cancel.reason).toBe('FINANCIAL_TREATMENT_UNDEFINED');
    const last = await selfServiceTenant({ commitment_end: '2026-11-25T00:00:00Z', period_end: '2026-11-25T00:00:00Z' });
    expect(await cancelAs(approved, last.t)).toMatchObject({ status: 'PENDING_PROVIDER' });
  });

  it('C7-FIN-2 DR-C7-1: upgrade runs every gate, refuses an unavailable plan (PLAN_NOT_AVAILABLE), then refuses FINANCIAL_TREATMENT_UNDEFINED (price change has no proration / usage ruling); nothing is written and Stripe is never called', async () => {
    now = T0;
    const { t, ss } = await selfServiceTenant();
    const before = await rowJson(ss);
    const calls = h.billing.calls.length;
    expect(await refusal(approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: BUSINESS }))).toBe('PLAN_NOT_AVAILABLE'); // the current plan
    expect(await refusal(approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: 'no-such-plan' }))).toBe('PLAN_NOT_AVAILABLE');
    expect(await refusal(approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: 'aramo-sign-enterprise-v1' }))).toBe('PLAN_NOT_AVAILABLE'); // contact sales
    const plans = await h.lifecycle.catalog('sign', t);
    const target = plans.find((p) => p.key !== BUSINESS && p.sales_model === 'SELF_SERVICE' && p.status === 'ACTIVE' && p.eligible);
    if (target !== undefined) {
      expect(await refusal(approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: target.key }))).toBe('FINANCIAL_TREATMENT_UNDEFINED');
    }
    try {
      await approved.upgrade({ tenant_id: t, product_key: 'sign', plan_key: target?.key ?? BUSINESS });
    } catch (e) {
      expect(e).toBeInstanceOf(SelfServiceRefusedError);
    }
    expect((await approved.view(t, 'sign')).actions.upgrade).toEqual({ available: false, reason: 'FINANCIAL_TREATMENT_UNDEFINED' });
    expect(await requestsOf(t)).toEqual([]);
    expect(await commandsOfTenant(t)).toEqual([]);
    expect(await rowJson(ss)).toBe(before);
    expect(h.billing.calls.length).toBe(calls);
  });

  // ---- MP-A2 N-12 per-product isolation ------------------------------------------------------

  describe('N-12 per-product isolation (the second key registered in THIS test database only)', () => {
    let iso: { t: string; ss: string; ref: string; isoRef: string; isoId: string };

    beforeAll(async () => {
      await registerIsolationTestProduct(pg);
      await pg.query(
        `INSERT INTO subscription."Plan" (id, key, name, product_key, sellable, sales_model, status, display_order)
         VALUES ($1::uuid, 'ccp-c7-isolation-plan', 'C7 isolation test plan', $2, true, 'SELF_SERVICE', 'ACTIVE', 51)`,
        [ISO_PLAN, ISO],
      );
      await publishTestPlanV1(pg, ISO_PLAN);
      const base = await selfServiceTenant();
      const isoRef = `sub_iso_${base.t}`;
      const isoId = randomUUID();
      await pg.query(
        `INSERT INTO subscription."TenantSubscription"
           (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, billing_provider, billing_account_ref, billing_subscription_ref, current_period_end)
         VALUES ($1::uuid, $2::uuid, $3::uuid, ${publishedVersionOf('$3::uuid')}, $4, 'BASE', '2026-10-09T00:00:00Z', 'SELF_SERVICE', 'ccp-c7', 'ACTIVE', 'STRIPE', $5, $6, '2026-11-09T00:00:00Z')`,
        [isoId, base.t, ISO_PLAN, ISO, `acct_${base.t}`, isoRef],
      );
      iso = { ...base, isoRef, isoId };
    });

    it('C7-ISO-0 the shipped registries are sign only: code (PRODUCT_KEYS, SELF_SERVICE_PRODUCTS) and every C7 DB registry CHECK; the test key appears in no migration', async () => {
      expect([...PRODUCT_KEYS]).toEqual(['sign']);
      expect(Object.keys(SELF_SERVICE_PRODUCTS)).toEqual(['sign']);
      const defs = (
        await pg.query(
          `SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname IN ('SelfServiceBillingRequest_product_key_registry_check', 'BillingProviderCommand_product_key_registry_check') ORDER BY conname`,
        )
      ).rows;
      expect(defs.map((r) => r.conname)).toEqual(['BillingProviderCommand_product_key_registry_check', 'SelfServiceBillingRequest_product_key_registry_check']);
      for (const r of defs) expect(r.d).toBe(`CHECK ((product_key = 'sign'::text))`);
      const dir = resolve(__dirname, '../../prisma/migrations');
      const all = readdirSync(dir)
        .filter((d) => /^\d{14}_/.test(d))
        .map((d) => readFileSync(resolve(dir, d, 'migration.sql'), 'utf8'))
        .join('\n');
      expect(all).not.toContain(ISO);
    });

    it('C7-ISO-1 the fixture: one tenant with an open SELF_SERVICE sign row AND an open SELF_SERVICE second-product row', async () => {
      const r = await pg.query(`SELECT product_key FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY product_key`, [iso.t]);
      expect(r.rows.map((x) => x.product_key)).toEqual([ISO, 'sign']);
    });

    it('C7-ISO-2 the sign view reads the sign row only; removing the other product row leaves the sign view byte-identical', async () => {
      const v1 = JSON.stringify(await approved.view(iso.t, 'sign'));
      expect(v1).toContain(BUSINESS);
      expect(v1).not.toContain('ccp-c7-isolation-plan');
      const saved = (await pg.query(`SELECT row_to_json(s) j FROM subscription."TenantSubscription" s WHERE id = $1`, [iso.isoId])).rows[0].j;
      await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now(), status = 'CANCELED' WHERE id = $1`, [iso.isoId]);
      expect(JSON.stringify(await approved.view(iso.t, 'sign'))).toBe(v1);
      await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = NULL, status = $2 WHERE id = $1`, [iso.isoId, saved.status]);
    });

    it('C7-ISO-3 the sign cancel targets the sign row only; the other product row is untouched and no command targets it; the other product cannot be named (code and DB refuse it)', async () => {
      const isoBefore = await rowJson(iso.isoId);
      const r = await cancelAs(approved, iso.t);
      const cmds = await commandsOfTenant(iso.t);
      expect(cmds.map((c) => [c.product_key, c.target_ref])).toEqual([['sign', iso.ref]]);
      await h.commands.dispatchDue(now);
      expect(h.billing.count('cancelSubscription', iso.isoRef)).toBe(0);
      expect(await rowJson(iso.isoId)).toBe(isoBefore);
      expect(r.status).toBe('PENDING_PROVIDER');
      // Code: an unregistered product is refused (fail closed) before any read.
      await expect(approved.view(iso.t, ISO as never)).rejects.toThrow(/not in the product registry/);
      await expect(approved.cancel({ tenant_id: iso.t, product_key: ISO as never, user_id: randomUUID() })).rejects.toThrow(/not in the product registry/);
      // DB: neither a request nor a command can name the test key.
      expect(
        await dbError(
          `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'CANCEL_AT_PERIOD_END', $3, 'STRIPE', $4, $5, gen_random_uuid(), now())`,
          [iso.t, ISO, iso.isoId, iso.isoRef, legalRef(APPROVED_TERMS[0]!)],
        ),
      ).toMatch(/SelfServiceBillingRequest_product_key_registry_check/);
      // A sign request naming the other product's row is refused by the trigger.
      expect(
        await dbError(
          `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
           VALUES (gen_random_uuid(), $1, 'sign', 'UPGRADE', $2, 'STRIPE', $3, $4, gen_random_uuid(), now())`,
          [iso.t, iso.isoId, iso.isoRef, legalRef(APPROVED_TERMS[0]!)],
        ),
      ).toMatch(/SelfServiceBillingRequest_action_check|tenant \/ product differ/);
      expect(
        await dbError(
          `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
           VALUES (gen_random_uuid(), $1, 'sign', 'CANCEL_AT_PERIOD_END', $2, 'STRIPE', $3, $4, gen_random_uuid(), now())`,
          [iso.t, iso.isoId, iso.isoRef, legalRef(APPROVED_TERMS[0]!)],
        ),
      ).toMatch(/tenant \/ product differ/);
    });

    it('C7-ISO-4 the provider-confirmed state of the sign subscription changes only the sign row; the other product row stays byte-identical', async () => {
      const isoBefore = await rowJson(iso.isoId);
      await h.commands.reconcilePending('sign', new Date(now.getTime() + 60_000));
      expect((await one(`SELECT cancel_at_period_end FROM subscription."TenantSubscription" WHERE id = $1`, [iso.ss])).cancel_at_period_end).toBe(true);
      expect(await rowJson(iso.isoId)).toBe(isoBefore);
    });
  });

  // ---- DB backstops ---------------------------------------------------------------------------

  it('C7-DB-1 the command origin is exactly one; the self-service key is derived; a self-service command is SUBSCRIPTION_CANCEL AT_PERIOD_END on its request target only; requests and the new column are immutable; requests are never deleted', async () => {
    now = T0;
    const { t, ref } = await selfServiceTenant();
    const r = await cancelAs(approved, t);
    const ins = (cols: string, vals: string, p: unknown[]) =>
      dbError(`INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, ${cols}, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at) VALUES (gen_random_uuid(), 'STRIPE', ${vals}, 'sign', $3, $4::jsonb, 'PENDING', 0, gen_random_uuid(), now(), now())`, p);
    // free-text key
    expect(await ins('self_service_request_id', `'SUBSCRIPTION_CANCEL', $1::uuid, 'other_step', 'free-text', $2::uuid`, [r.request_id, t, ref, '{"mode":"AT_PERIOD_END"}'])).toMatch(/idempotency_key_check/);
    // IMMEDIATE is not a self-service mode
    expect(
      await ins('self_service_request_id', `'SUBSCRIPTION_CANCEL', $1::uuid, 'other_step', 'aramo-ccp-ss-' || $1::text || '-other_step', $2::uuid`, [r.request_id, t, ref, '{"mode":"IMMEDIATE"}']),
    ).toMatch(/issues only SUBSCRIPTION_CANCEL AT_PERIOD_END/);
    // another target
    expect(
      await ins('self_service_request_id', `'SUBSCRIPTION_CANCEL', $1::uuid, 'other_step', 'aramo-ccp-ss-' || $1::text || '-other_step', $2::uuid`, [r.request_id, t, 'sub_other', '{"mode":"AT_PERIOD_END"}']),
    ).toMatch(/differ from self-service request/);
    // no origin
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', 'x', 'x', $1, 'sign', $2, '{"mode":"AT_PERIOD_END"}', 'PENDING', 0, gen_random_uuid(), now(), now())`,
        [t, ref],
      ),
    ).toMatch(/exactly one origin/);
    // both origins
    expect(
      await ins('change_request_id, self_service_request_id', `'SUBSCRIPTION_CANCEL', gen_random_uuid(), $1::uuid, 'other_step', 'aramo-ccp-ss-' || $1::text || '-other_step', $2::uuid`, [r.request_id, t, ref, '{"mode":"AT_PERIOD_END"}']),
    ).toMatch(/exactly one origin/);
    expect(await dbError(`UPDATE subscription."BillingProviderCommand" SET self_service_request_id = gen_random_uuid() WHERE self_service_request_id = $1`, [r.request_id])).toMatch(/immutable|fkey/);
    expect(await dbError(`UPDATE subscription."SelfServiceBillingRequest" SET terms_ref = terms_ref WHERE id = $1`, [r.request_id])).toMatch(/immutable/);
    expect(await dbError(`DELETE FROM subscription."SelfServiceBillingRequest" WHERE id = $1`, [r.request_id])).toMatch(/never deleted/);
  });

  it('C7-DB-2 the change-request origin is unchanged (C1 rules): a free-text key and a non-approved request are still refused', async () => {
    const { t, ref } = await selfServiceTenant();
    const t2 = await selfServiceTenant(); // Q14: one open request per tenant × product
    const draft = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: { direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: INCLUDED, plan_version_id: randomUUID() }, reason: 'c7 db', idempotency_key: key() }, A6_CTX);
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 's', 'aramo-ccp-' || $1::text || '-s', $2::uuid, 'sign', $3, '{"mode":"IMMEDIATE"}', 'PENDING', 0, gen_random_uuid(), now(), now())`,
        [draft.request.id, t, ref],
      ),
    ).toMatch(/needs a completed approval chain/);
    expect(
      await dbError(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 's', 'free-text', $2::uuid, 'sign', $3, '{"mode":"IMMEDIATE"}', 'PENDING', 0, gen_random_uuid(), now(), now())`,
        [await conversion(t2.t, { direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: INCLUDED, plan_version_id: randomUUID() }), t2.t, t2.ref],
      ),
    ).toMatch(/idempotency_key_check/);
  });

  // ---- compensating SQL (documented, not shipped) ---------------------------------------------

  const C7_MIGRATION = resolve(__dirname, '../../prisma/migrations/20261028030000_ccp_c7_self_service_commands/migration.sql');
  const C7_COMPENSATING = resolve(__dirname, 'fixtures/ccp-c7-compensating.sql');

  it('C7-COMP-1 the compensation is refused (RAISE, nothing changed) while self-service requests or commands exist', async () => {
    const before = (await one(`SELECT count(*)::int n FROM subscription."SelfServiceBillingRequest"`)).n as number;
    expect(before).toBeGreaterThan(0);
    await pg.query('BEGIN');
    try {
      await expect(pg.query(readFileSync(C7_COMPENSATING, 'utf8'))).rejects.toThrow(/CCP-C7 compensation refused/);
    } finally {
      await pg.query('ROLLBACK');
    }
    expect((await one(`SELECT count(*)::int n FROM subscription."SelfServiceBillingRequest"`)).n).toBe(before);
    expect((await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'BillingProviderCommand' AND column_name = 'self_service_request_id'`)).n).toBe(1);
  });

  it('C7-COMP-2 on a fresh full chain: after the command-guard-union compensation, the C7 compensation applies with 0 errors and restores the preceding shape (guard body byte-equal to CCP-C4\'s, merge train TD-MERGE-CMDGUARD-1); C7 and the union re-apply with 0 errors', async () => {
    await pg.query('CREATE DATABASE c7_comp');
    const url = container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/c7_comp$1');
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await applyCcpA6Schema(c);
      const guardSrc = async () => (await c.query(`SELECT prosrc FROM pg_proc WHERE proname = 'guard_billing_provider_command'`)).rows[0].prosrc as string;
      const c7Src = await guardSrc();
      expect(c7Src).toContain('>>> CCP-C7 self-service origin');
      // Merge train TD-MERGE-CMDGUARD-1: the reverse chain starts with the command-guard union.
      await c.query('BEGIN');
      await c.query(readFileSync(resolve(__dirname, 'fixtures/ccp-command-guard-union-compensating.sql'), 'utf8'));
      await c.query('COMMIT');
      await c.query('BEGIN');
      await c.query(readFileSync(C7_COMPENSATING, 'utf8'));
      await c.query('COMMIT');
      const c4 = readFileSync(resolve(__dirname, '../../prisma/migrations/20261028010000_ccp_c4_billing_adjustments/migration.sql'), 'utf8');
      const at = c4.indexOf('FUNCTION "subscription"."guard_billing_provider_command"()');
      const c4Body = c4.slice(c4.indexOf('AS $$', at) + 5, c4.indexOf('$$ LANGUAGE plpgsql;', at));
      expect(await guardSrc()).toBe(c4Body);
      expect((await c.query(`SELECT to_regclass('subscription."SelfServiceBillingRequest"') r`)).rows[0].r).toBeNull();
      expect((await c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'BillingProviderCommand' AND column_name = 'change_request_id'`)).rows[0].is_nullable).toBe('NO');
      expect((await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'BillingProviderCommand' AND column_name = 'self_service_request_id'`)).rows[0].n).toBe(0);
      await c.query(readFileSync(C7_MIGRATION, 'utf8'));
      await c.query(readFileSync(resolve(__dirname, '../../prisma/migrations/20261029000000_ccp_command_guard_union/migration.sql'), 'utf8'));
      expect(await guardSrc()).toBe(c7Src);
      expect((await c.query(`SELECT to_regclass('subscription."SelfServiceBillingRequest"') r`)).rows[0].r).not.toBeNull();
    } finally {
      await c.end();
    }
  });

  it('C7-TX-1 no Stripe call ran inside a local DB transaction across this file (dispatch, re-fetch, inbox)', () => {
    expect(h.billing.probes).toBeGreaterThan(5);
    expect(h.billing.violations).toEqual([]);
  });
});
