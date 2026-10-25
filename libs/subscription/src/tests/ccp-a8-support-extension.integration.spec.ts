import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply.service.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { type SupportExtensionOutcome } from '../lib/commercial/support-extension.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { POLICY_V1, addOperator, applyCcpA6Schema, revokeRole } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, a6Harness, as, newTenant, rawSubscription, waitForAdvisoryWaiter, type A6Harness } from './support/ccp-a6.js';

// CCP-A8 (PBD §5.1 row A8 mandatory tests; DDR v1.2 §3.2(5); Q7; Recon Report G1) on real
// Postgres 17: identity + entitlement + metering + EVERY subscription migration (A8 included)
// applied whole-file by the shared CCP helper. A TRIPWIRE trigger installed for the whole spec
// raises on ANY update or delete of a Stripe-owned TenantSubscription row (SELF_SERVICE or
// provider-linked): every A8 path below (bounded apply, escalation, approved apply, removal)
// runs under it, so "any mutation of a Stripe-owned row" (the A8 HALT) would fail the spec.
// Test IDs are cited by doc/ccp/slices/CCP-A8-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const KEY = 'sign.envelopes';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A8 support exception overlay (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let lockHolder: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let clock = T0;
  let SA: string; // support_admin (attested)
  let SA_UNATTESTED: string;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  const key = () => `a8-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    lockHolder = new Client({ connectionString: url });
    await lockHolder.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => clock);
    SA = await addOperator(pg, ['support_admin']);
    SA_UNATTESTED = await addOperator(pg, ['support_admin'], { attested: false });
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    // The G1 tripwire (test-only): a Stripe-owned row is never written by any A8 path.
    await pg.query(`CREATE FUNCTION subscription.a8_stripe_row_tripwire() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'A8 TRIPWIRE: % of a Stripe-owned TenantSubscription row %', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql`);
    await pg.query(`CREATE TRIGGER a8_stripe_row_tripwire BEFORE UPDATE OR DELETE ON subscription."TenantSubscription"
      FOR EACH ROW WHEN (OLD.source = 'SELF_SERVICE' OR OLD.billing_subscription_ref IS NOT NULL) EXECUTE FUNCTION subscription.a8_stripe_row_tripwire()`);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await lockHolder?.end();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- fixtures ----------------------------------------------------------------------

  /** A Stripe-owned (SELF_SERVICE, provider-linked) open BASE row, inserted in its final state. */
  async function stripeRow(tenant_id: string, o: { status?: string; grace_until?: Date | null } = {}): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, grace_until, billing_provider, billing_account_ref, billing_subscription_ref)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', '2026-10-01T00:00:00Z', 'SELF_SERVICE', 'ccp-a8-spec', $3, $4, 'STRIPE', $5, $6
         FROM subscription."Plan" p WHERE p.key = $7`,
      [id, tenant_id, o.status ?? 'PAST_DUE', o.grace_until === undefined ? new Date(T0.getTime() - DAY) : o.grace_until, `acct_${tenant_id}`, `sub_${id}`, BUSINESS],
    );
    return id;
  }
  async function consumed(tenant_id: string, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await pg.query(
        `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_at, reserved_until, finalized_at) VALUES (gen_random_uuid(), $1, $2, $3, '2026-10-01T00:00:00Z', 'CONSUMED', '2026-10-10T00:00:00Z', '2026-10-10T00:10:00Z', '2026-10-10T00:01:00Z')`,
        [tenant_id, KEY, `a8-env-${tenant_id}-${i}`],
      );
    }
  }
  const rowJson = async (id: string) => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [id])).rows[0].j as string;
  const usageJson = async (t: string) => (await pg.query(`SELECT row_to_json(u)::text j FROM subscription."AllowanceUsage" u WHERE tenant_id = $1 ORDER BY id`, [t])).rows.map((r) => r.j as string);
  const overlays = async (t: string) => (await pg.query(`SELECT * FROM subscription."SupportExtension" WHERE tenant_id = $1 ORDER BY applied_at, id`, [t])).rows;
  const counts = async (t: string) =>
    (
      await pg.query(
        `SELECT (SELECT count(*)::int FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1) AS requests,
                (SELECT count(*)::int FROM subscription."CommercialChangeApplication" WHERE tenant_id = $1) AS applications,
                (SELECT count(*)::int FROM subscription."SupportExtension" WHERE tenant_id = $1) AS overlays,
                (SELECT count(*)::int FROM subscription."CommercialAuditEvent" WHERE tenant_id = $1) AS audit`,
        [t],
      )
    ).rows[0];
  const events = async (id: string) =>
    (await pg.query(`SELECT event_type, is_exception, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows as Array<{ event_type: string; is_exception: boolean; payload: Record<string, unknown> }>;

  const extend = (tenant_id: string, subscription_id: string, requested_days: number, user = SA, k = key()) =>
    h.supportExtensions.request(as(user, 'support_admin'), { tenant_id, product_key: 'sign', subscription_id, requested_days, reason: 'Support goodwill: billing contact on leave', idempotency_key: k }, A6_CTX);
  async function outcome(p: Promise<SupportExtensionOutcome | unknown>): Promise<string> {
    try {
      const r = (await p) as SupportExtensionOutcome;
      return r.outcome;
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) return `ERROR:${e.code}${typeof e.details['reason'] === 'string' ? `:${e.details['reason']}` : ''}`;
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      throw e;
    }
  }
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      try {
        await pg.query('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }
  /** Finance approves an escalated (PENDING) request; the requester applies it through the A6 path. */
  async function approveAndApply(id: string, applier = SA) {
    const a = await h.changeRequests.approve(as(FA, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return h.apply.apply(as(applier, 'support_admin'), id, A6_CTX);
  }

  // ---- in bounds: applies as a bounded EXCEPTION ---------------------------------------

  it('A8-APPLY-1 in bounds (14 days, a Stripe-owned PAST_DUE row past grace): ONE transaction applies a kind EXCEPTION request with zero approvals and the BOUNDED_EXCEPTION chain, the overlay, the application record, and every audit event with is_exception = true; the Stripe-owned row is byte-identical', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const before = await rowJson(sub);
    const out = await extend(t, sub, 14);
    expect(out.outcome).toBe('APPLIED');
    if (out.outcome !== 'APPLIED') throw new Error('unreachable');
    expect(out.request).toMatchObject({ action_type: 'SUPPORT_EXTENSION', kind: 'EXCEPTION', state: 'APPLIED', apply_attempts: 1, requested_by: SA, policy_version_id: POLICY_V1 });
    expect(out.request.required_chain).toMatchObject({ rule: 'BOUNDED_EXCEPTION', steps: [] });
    expect(out.request.payload).toEqual({ operation: 'EXTEND', subscription_id: sub, requested_days: 14 });
    expect(out.extension).toMatchObject({ subscription_id: sub, is_exception: true, days: 14, applied_by: SA, removed_at: null, policy_version_id: POLICY_V1 });
    // Grace had ended a day ago → the window starts at the apply instant.
    expect(out.extension.base_until).toEqual(T0);
    expect(out.extension.extends_until).toEqual(new Date(T0.getTime() + 14 * DAY));
    expect(out.application).toMatchObject({ action_type: 'SUPPORT_EXTENSION', subscription_id: sub, capabilities: [], capabilities_inserted: [], attempt: 1, applied_by: SA });
    expect(out.decision).toMatchObject({ within_bounds: true, breaches: [], counters: { requested_days: 14, extensions_in_frequency_window: 0, cumulative_days_before: 0, cumulative_days_after: 14 } });
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [out.request.id])).rows[0].n).toBe(0);
    const ev = await events(out.request.id);
    expect(ev.map((e) => e.event_type)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED', 'SUPPORT_EXTENSION_EXCEPTION_APPLIED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    expect(ev.every((e) => e.is_exception)).toBe(true);
    expect(ev[1]?.payload).toMatchObject({ subscription_id: sub, subscription_source: 'SELF_SERVICE', provider_linked: true, days: 14, extends_until: new Date(T0.getTime() + 14 * DAY).toISOString() });
    expect(ev[2]?.payload).toMatchObject({ outcome: 'APPLIED', kind: 'EXCEPTION', approvals: [], exception: { zero_approvals: true, counters: { cumulative_days_after: 14 }, clause: { support_extension_max_days: 14 } } });
    expect(await rowJson(sub)).toBe(before);
  });

  it('A8-T8-1 the overlay only changes WHETHER the row sends: limit, used, remaining and period equal an ACTIVE twin on the same plan; the usage ledger is byte-identical; sending stops at exactly extends_until (half-open)', async () => {
    clock = T0;
    const twin = await newTenant(pg);
    await stripeRow(twin, { status: 'ACTIVE', grace_until: null });
    await consumed(twin, 3);
    const baseline = await h.allowance.getStatus(twin, 'sign', KEY, T0);
    expect(baseline.subscribed).toBe(true);

    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    await consumed(t, 3);
    expect(await h.allowance.getStatus(t, 'sign', KEY, T0)).toEqual({ subscribed: false, allowance_key: KEY, state: 'PAST_DUE' });
    const ledger = await usageJson(t);
    const out = await extend(t, sub, 7);
    expect(out.outcome).toBe('APPLIED');
    const during = await h.allowance.getStatus(t, 'sign', KEY, T0);
    expect(during).toEqual(baseline);
    expect(await usageJson(t)).toEqual(ledger);
    const until = new Date(T0.getTime() + 7 * DAY);
    expect((await h.allowance.getStatus(t, 'sign', KEY, new Date(until.getTime() - 1))).subscribed).toBe(true);
    expect(await h.allowance.getStatus(t, 'sign', KEY, until)).toEqual({ subscribed: false, allowance_key: KEY, state: 'PAST_DUE' });
    // An overlay of ANOTHER row of the same tenant never makes this one send (keyed to the row).
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."SupportExtension" WHERE subscription_id <> $1 AND tenant_id = $2`, [sub, t])).rows[0].n).toBe(0);
  });

  it('A8-APPLY-2 grace still running → the extension starts at grace_until (base_until = grace_until, extends_until = grace_until + days)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const grace = new Date(T0.getTime() + 2 * DAY);
    const sub = await stripeRow(t, { grace_until: grace });
    const out = await extend(t, sub, 5);
    if (out.outcome !== 'APPLIED') throw new Error(`expected APPLIED, got ${out.outcome}`);
    expect(out.extension).toMatchObject({ grace_until_at_apply: grace, base_until: grace, extends_until: new Date(grace.getTime() + 5 * DAY) });
  });

  // ---- breaches escalate and never apply ------------------------------------------------

  it('A8-ESC-LEN-1 15 days (LENGTH) escalates: a NORMAL request PENDING_APPROVAL on the Finance-only chain (Q7), no overlay, no application, the row still does not send, SUPPORT_EXTENSION_ESCALATED records the breach', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const before = await rowJson(sub);
    const out = await extend(t, sub, 15);
    expect(out.outcome).toBe('ESCALATED');
    expect(out.request).toMatchObject({ action_type: 'SUPPORT_EXTENSION', kind: 'NORMAL', state: 'PENDING_APPROVAL' });
    expect(out.request.required_chain).toMatchObject({ rule: 'FINANCE_ONLY', basis: { ruling: 'Q7 escalated support extension' }, steps: [{ step_index: 0, role_key: 'finance_admin' }] });
    expect(out.decision).toMatchObject({ within_bounds: false, breaches: ['LENGTH'] });
    expect(await overlays(t)).toEqual([]);
    expect((await counts(t)).applications).toBe(0);
    expect((await h.allowance.getStatus(t, 'sign', KEY, T0)).subscribed).toBe(false);
    const ev = await events(out.request.id);
    expect(ev.map((e) => e.event_type)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED', 'SUPPORT_EXTENSION_ESCALATED']);
    expect(ev.some((e) => e.is_exception)).toBe(false);
    expect(ev[2]?.payload).toMatchObject({ breaches: ['LENGTH'], applied: false, counters: { requested_days: 15 } });
    expect(await rowJson(sub)).toBe(before);
  });

  it('A8-ESC-FREQ-1 frequency boundary through the real path: a prior extension exactly 90 days old has aged out (applies); 90 days − 1 ms escalates (FREQUENCY)', async () => {
    const run = async (ageMs: number) => {
      const t = await newTenant(pg);
      const sub = await stripeRow(t, { grace_until: null });
      clock = new Date(T0.getTime() - ageMs);
      expect(await outcome(extend(t, sub, 1))).toBe('APPLIED');
      clock = T0;
      const out = await extend(t, sub, 1);
      return [out.outcome, out.decision?.breaches ?? null, (await overlays(t)).length];
    };
    expect(await run(90 * DAY)).toEqual(['APPLIED', [], 2]);
    expect(await run(90 * DAY - 1)).toEqual(['ESCALATED', ['FREQUENCY'], 1]);
    expect(await run(90 * DAY + 1)).toEqual(['APPLIED', [], 2]);
  });

  it('A8-ESC-CUM-1 cumulative boundary through the real path: 14 + 14 applied 300 and 200 days ago; +2 = 30 applies, +3 = 31 escalates (CUMULATIVE)', async () => {
    const run = async (requested: number) => {
      const t = await newTenant(pg);
      const sub = await stripeRow(t, { grace_until: null });
      for (const age of [300, 200]) {
        clock = new Date(T0.getTime() - age * DAY);
        expect(await outcome(extend(t, sub, 14))).toBe('APPLIED');
      }
      clock = T0;
      const out = await extend(t, sub, requested);
      return [out.outcome, out.decision?.breaches ?? null, out.decision?.counters.cumulative_days_after ?? null, (await overlays(t)).length];
    };
    expect(await run(2)).toEqual(['APPLIED', [], 30, 3]);
    expect(await run(3)).toEqual(['ESCALATED', ['CUMULATIVE'], 31, 2]);
  });

  it('A8-ESC-ELIG-1 eligibility breaches escalate and never apply: a row that is not PAST_DUE; a support_admin without an active D9 attestation', async () => {
    clock = T0;
    const t1 = await newTenant(pg);
    const active = await stripeRow(t1, { status: 'ACTIVE', grace_until: null });
    const a = await extend(t1, active, 3);
    expect([a.outcome, a.decision?.breaches, a.decision?.eligibility]).toEqual(['ESCALATED', ['ELIGIBILITY'], ['SUBSCRIPTION_NOT_PAST_DUE']]);
    expect(await overlays(t1)).toEqual([]);
    const t2 = await newTenant(pg);
    const sub = await stripeRow(t2);
    const b = await extend(t2, sub, 3, SA_UNATTESTED);
    expect([b.outcome, b.decision?.breaches, b.decision?.eligibility]).toEqual(['ESCALATED', ['ELIGIBILITY'], ['REQUESTER_NOT_ATTESTED']]);
    expect(await overlays(t2)).toEqual([]);
    expect((await h.allowance.getStatus(t2, 'sign', KEY, T0)).subscribed).toBe(false);
  });

  // ---- escalated → approved → applied (the A6 path, reused) -----------------------------

  it('TD-B6-5 (merge train) apply_actionable on the integrated branch: after Finance approves an escalated extension, only its requester (support_admin) reads true; the approver and another support_admin read false', async () => {
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const esc = await extend(t, sub, 20);
    expect(esc.outcome).toBe('ESCALATED');
    await h.changeRequests.approve(as(FA, 'finance_admin'), esc.request.id, { step_index: 0 }, A6_CTX);
    const SA2 = await addOperator(pg, ['support_admin']);
    const view = async (user: string, role: string) => (await h.changeRequests.get(as(user, role), esc.request.id, A6_CTX)).apply_actionable;
    expect(await view(SA, 'support_admin')).toBe(true);
    expect(await view(FA, 'finance_admin')).toBe(false);
    expect(await view(SA2, 'support_admin')).toBe(false);
  });

  it('A8-ESC-APPLY-1 an escalated extension, once Finance approves, is applied by the requester authority through CommercialApplyService.apply: overlay is_exception = false, SUPPORT_EXTENSION_APPLIED; the Stripe-owned row is byte-identical; a role without the authority is refused', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const before = await rowJson(sub);
    const esc = await extend(t, sub, 20);
    expect(esc.outcome).toBe('ESCALATED');
    await h.changeRequests.approve(as(FA, 'finance_admin'), esc.request.id, { step_index: 0 }, A6_CTX);
    // Merge train TD-MERGE-31: A6-R's requester-only preflight (TD-A6-3) refuses a non-requester first.
    await expect(h.apply.apply(as(FA, 'finance_admin'), esc.request.id, A6_CTX)).rejects.toMatchObject({ code: 'NOT_REQUESTER' });
    const out = await h.apply.apply(as(SA, 'support_admin'), esc.request.id, A6_CTX);
    expect(out.request).toMatchObject({ state: 'APPLIED', kind: 'NORMAL', apply_attempts: 1 });
    expect(out.application).toMatchObject({ action_type: 'SUPPORT_EXTENSION', subscription_id: sub, capabilities: [] });
    const [o] = await overlays(t);
    expect(o).toMatchObject({ is_exception: false, days: 20, change_request_id: esc.request.id });
    const ev = await events(esc.request.id);
    expect(ev.map((e) => e.event_type).slice(-2)).toEqual(['SUPPORT_EXTENSION_APPLIED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    expect(ev.some((e) => e.is_exception)).toBe(false);
    expect((await h.allowance.getStatus(t, 'sign', KEY, T0)).subscribed).toBe(true);
    expect(await rowJson(sub)).toBe(before);
    // Replay: nothing written.
    const again = await h.apply.apply(as(SA, 'support_admin'), esc.request.id, A6_CTX);
    expect(again.replayed).toBe(true);
    expect((await overlays(t)).length).toBe(1);
  });

  it('A8-ESC-NC5-1 NC-5 through the reused apply: the Finance signer loses the role after approval → apply refused, nothing written, request stays APPROVED', async () => {
    clock = T0;
    const signer = await addOperator(pg, ['finance_admin']);
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const esc = await extend(t, sub, 20);
    await h.changeRequests.approve(as(signer, 'finance_admin'), esc.request.id, { step_index: 0 }, A6_CTX);
    await revokeRole(pg, signer, 'finance_admin');
    expect(await outcome(h.apply.apply(as(SA, 'support_admin'), esc.request.id, A6_CTX))).toBe('REFUSED:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await overlays(t)).toEqual([]);
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [esc.request.id])).rows[0].state).toBe('APPROVED');
  });

  it('A8-ESC-STALE-1 the approved row ended before apply → APPLY_FAILED TARGET_STALE (retryable), no overlay', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED, status: 'PAST_DUE' });
    const esc = await extend(t, sub, 20);
    await h.changeRequests.approve(as(FA, 'finance_admin'), esc.request.id, { step_index: 0 }, A6_CTX);
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now(), status = 'CANCELED' WHERE id = $1`, [sub]);
    expect(await outcome(h.apply.apply(as(SA, 'support_admin'), esc.request.id, A6_CTX))).toBe('FAILED:TARGET_STALE');
    expect(await overlays(t)).toEqual([]);
  });

  // ---- recovery: the overlay is removable by change request ----------------------------

  it('A8-REMOVE-1 the overlay is removed by a change request (operation REMOVE, Finance-only chain, applied by the requester authority): removed_at set once, sending stops, the Stripe-owned row is byte-identical; a second removal fails EXTENSION_ALREADY_REMOVED; the removed extension still counts toward frequency (fail closed)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const before = await rowJson(sub);
    const applied = await extend(t, sub, 10);
    if (applied.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    expect((await h.allowance.getStatus(t, 'sign', KEY, T0)).subscribed).toBe(true);
    const removal = async () => {
      const r = await h.changeRequests.create(as(SA, 'support_admin'), { action_type: 'SUPPORT_EXTENSION', tenant_id: t, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: applied.extension.id }, reason: 'Extension granted in error', idempotency_key: key() }, A6_CTX);
      expect(r.request.required_chain).toMatchObject({ rule: 'FINANCE_ONLY', basis: { ruling: 'TD-A8 support extension removal' } });
      await h.changeRequests.submit(as(SA, 'support_admin'), r.request.id, A6_CTX);
      return r.request.id;
    };
    clock = new Date(T0.getTime() + DAY);
    const rid = await removal();
    const out = await approveAndApply(rid);
    expect(out.request.state).toBe('APPLIED');
    const [o] = await overlays(t);
    expect(o).toMatchObject({ removed_by: SA, remove_change_request_id: rid });
    expect(o.removed_at).toEqual(clock);
    expect((await h.allowance.getStatus(t, 'sign', KEY, clock)).subscribed).toBe(false);
    expect((await events(rid)).map((e) => e.event_type).slice(-2)).toEqual(['SUPPORT_EXTENSION_REMOVED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    const rid2 = await removal();
    expect(await outcome(approveAndApply(rid2))).toBe('FAILED:EXTENSION_ALREADY_REMOVED');
    await h.changeRequests.withdraw(as(SA, 'support_admin'), rid2, A6_CTX).catch(() => undefined);
    expect(await rowJson(sub)).toBe(before);
  });

  // ---- refusals: nothing is written --------------------------------------------------------

  it('A8-REFUSE-1 refusals write nothing: scope missing (commercial_ops), not a user principal, the platform tenant, an unknown tenant, a row of another tenant, an ended row, invalid days, an open change request (Q14)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const other = await newTenant(pg);
    const otherSub = await stripeRow(other);
    const ended = await newTenant(pg);
    const endedSub = await rawSubscription(pg, ended, { source: 'MANUAL', plan: INCLUDED, status: 'PAST_DUE' });
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now(), status = 'CANCELED' WHERE id = $1`, [endedSub]);
    const before = await counts(t);
    const req = (o: Partial<{ tenant_id: string; subscription_id: string; requested_days: number }>, actor = as(SA, 'support_admin')) =>
      outcome(h.supportExtensions.request(actor, { tenant_id: t, product_key: 'sign', subscription_id: sub, requested_days: 3, reason: 'x support', idempotency_key: key(), ...o }, A6_CTX));
    expect(await req({}, as(OPS, 'commercial_ops'))).toBe('ERROR:REQUESTER_SCOPE_MISSING');
    expect(await req({}, as(SA, 'support_admin', { actor_kind: 'service' }))).toBe('ERROR:NOT_HUMAN');
    expect(await req({ tenant_id: A6_CTX.platform_tenant_id })).toBe('ERROR:INVALID_INPUT:platform_tenant');
    expect(await req({ tenant_id: randomUUID() })).toBe('ERROR:TENANT_NOT_FOUND');
    expect(await req({ subscription_id: otherSub })).toBe('ERROR:INVALID_INPUT:subscription_not_open');
    expect(await req({ tenant_id: ended, subscription_id: endedSub })).toBe('ERROR:INVALID_INPUT:subscription_not_open');
    expect(await req({ requested_days: 0 })).toBe('ERROR:INVALID_INPUT:invalid_payload');
    expect(await counts(t)).toEqual(before);
    // Q14: an escalated request holds the slot; a new extension is refused, nothing written.
    expect((await extend(t, sub, 20)).outcome).toBe('ESCALATED');
    const held = await counts(t);
    expect(await req({})).toBe('ERROR:OPEN_REQUEST_EXISTS');
    expect(await counts(t)).toEqual(held);
  });

  it('A8-IDEM-1 idempotency: a replay returns the same applied request and overlay (replayed, nothing written); the same key with another body conflicts', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const k = key();
    const first = await extend(t, sub, 4, SA, k);
    const snap = await counts(t);
    const again = await extend(t, sub, 4, SA, k);
    expect(again).toMatchObject({ outcome: 'APPLIED', replayed: true, decision: null });
    expect(again.request.id).toBe(first.request.id);
    expect(await counts(t)).toEqual(snap);
    expect(await outcome(extend(t, sub, 5, SA, k))).toBe('ERROR:IDEMPOTENCY_KEY_CONFLICT');
  });

  it('A8-CONC-1 four concurrent in-bound extensions of one tenant serialize under the billing lock: exactly one applies, exactly one overlay; the others escalate (FREQUENCY) or are refused (Q14)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const results = await Promise.all([0, 1, 2, 3].map(() => outcome(extend(t, sub, 2))));
    expect(results.filter((r) => r === 'APPLIED')).toHaveLength(1);
    expect(results.filter((r) => r === 'ESCALATED').length).toBeLessThanOrEqual(1);
    expect(results.every((r) => ['APPLIED', 'ESCALATED', 'ERROR:OPEN_REQUEST_EXISTS'].includes(r))).toBe(true);
    expect(await overlays(t)).toHaveLength(1);
  });

  it('A8-LOCK-1 the bounded apply waits on the billing lock (webhook and console serialize)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    await lockHolder.query('BEGIN');
    await lockHolder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:${t}`]);
    const pending = extend(t, sub, 2);
    await waitForAdvisoryWaiter(pg);
    expect(await overlays(t)).toEqual([]);
    await lockHolder.query('COMMIT');
    expect((await pending).outcome).toBe('APPLIED');
  });

  // ---- DB backstops (no bypass through SQL) -------------------------------------------------

  it('A8-TRG-1 SupportExtension: no INSERT without its applying request; no UPDATE but one removal; no DELETE', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const out = await extend(t, sub, 3);
    if (out.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    const ext = out.extension.id;
    expect(
      await raises(
        `INSERT INTO subscription."SupportExtension" (id, tenant_id, product_key, subscription_id, change_request_id, is_exception, days, base_until, extends_until, policy_version_id, applied_by, applied_at)
         VALUES (gen_random_uuid(), $1, 'sign', $2, $3, true, 3, now(), now() + interval '3 days', $4, $5, now())`,
        [t, sub, out.request.id, POLICY_V1, SA],
      ),
    ).toMatch(/requires its SUPPORT_EXTENSION \(EXTEND\) change request in APPLYING|duplicate key/);
    expect(await raises(`UPDATE subscription."SupportExtension" SET extends_until = extends_until + interval '1 day' WHERE id = $1`, [ext])).toContain('allows only a single removal');
    expect(await raises(`UPDATE subscription."SupportExtension" SET removed_at = now(), removed_by = $2, remove_change_request_id = $3 WHERE id = $1`, [ext, SA, out.request.id])).toContain('removal requires its SUPPORT_EXTENSION (REMOVE) change request in APPLYING');
    expect(await raises(`DELETE FROM subscription."SupportExtension" WHERE id = $1`, [ext])).toContain('append-only (DELETE rejected)');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'WITHDRAWN' WHERE id = $1`, [out.request.id])).toContain('terminal state APPLIED is immutable');
  });

  it('A8-TRG-2 guard: a bounded EXCEPTION never enters the approval states, never commits in DRAFT, never reaches APPLIED without its overlay; a NORMAL SUPPORT_EXTENSION never skips the chain (DRAFT → APPLYING)', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    const policy = (await pg.query(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [POLICY_V1])).rows[0].content_checksum as string;
    const insert = (kind: string, chain: unknown) =>
      `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, state, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, idempotency_key, created_at, updated_at)
       VALUES ('%ID%', 'SUPPORT_EXTENSION', '${kind}', 'DRAFT', '${t}', 'sign', '{"operation":"EXTEND","subscription_id":"${sub}","requested_days":3}', '${'a'.repeat(64)}', '${JSON.stringify(chain)}', '${POLICY_V1}', '${policy}', '${SA}', 'raw', '${randomUUID()}', now(), now())`;
    const bounded = { format_version: 1, rule: 'BOUNDED_EXCEPTION', basis: {}, steps: [] };
    // Commit in DRAFT refused (deferred).
    expect(await raises(insert('EXCEPTION', bounded).replace('%ID%', randomUUID()))).toContain('can commit only as APPLIED');
    // DRAFT → PENDING_APPROVAL refused for an EXCEPTION.
    let id = randomUUID();
    await pg.query('BEGIN');
    await pg.query(insert('EXCEPTION', bounded).replace('%ID%', id));
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'PENDING_APPROVAL', submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [id])).toContain('bounded EXCEPTION state DRAFT -> PENDING_APPROVAL is not allowed');
    // APPLYING → APPLIED without the overlay refused.
    id = randomUUID();
    await pg.query('BEGIN');
    await pg.query(insert('EXCEPTION', bounded).replace('%ID%', id));
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toContain('without its CommercialChangeApplication');
    // An EXCEPTION with a non-empty chain cannot apply.
    id = randomUUID();
    await pg.query('BEGIN');
    await pg.query(insert('EXCEPTION', { format_version: 1, rule: 'FINANCE_ONLY', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:subscription:approve'] }] }).replace('%ID%', id));
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [id])).toContain('zero-step BOUNDED_EXCEPTION chain');
    // A NORMAL SUPPORT_EXTENSION cannot skip the chain.
    id = randomUUID();
    await pg.query('BEGIN');
    await pg.query(insert('NORMAL', { format_version: 1, rule: 'FINANCE_ONLY', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:subscription:approve'] }] }).replace('%ID%', id));
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [id])).toContain('state DRAFT -> APPLYING is not allowed');
    expect(await overlays(t)).toEqual([]);
  });

  // ---- Architect conditions on TD-A8-5 / TD-A8-6 (APPROVED; verification required) ---------

  /** A Stripe-owned PAST_DUE row carrying EVERY provider-sourced field (status, period, cancellation, refs, event time, owner). */
  async function stripeRowFull(tenant_id: string): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, grace_until,
              billing_provider, billing_account_ref, billing_subscription_ref, current_period_end, cancel_at_period_end, provider_state_at, activated_by)
       SELECT $1::uuid, $2::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', '2026-10-01T00:00:00Z', 'SELF_SERVICE', 'ccp-a8-spec', 'PAST_DUE', $3,
              'STRIPE', $4, $5, '2026-11-01T00:00:00Z', true, '2026-10-24T08:00:00Z', 'owner-user-1'
         FROM subscription."Plan" p WHERE p.key = $6`,
      [id, tenant_id, new Date(T0.getTime() - DAY), `acct_${tenant_id}`, `sub_${id}`, BUSINESS],
    );
    return id;
  }
  /** Removal by change request: support_admin requests and submits, finance_admin approves, support_admin applies (TD-A8-5). */
  async function removeExtension(tenant_id: string, support_extension_id: string): Promise<string> {
    const r = await h.changeRequests.create(as(SA, 'support_admin'), { action_type: 'SUPPORT_EXTENSION', tenant_id, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id }, reason: 'Extension no longer warranted', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(SA, 'support_admin'), r.request.id, A6_CTX);
    const out = await approveAndApply(r.request.id);
    expect(out.request.state).toBe('APPLIED');
    return r.request.id;
  }
  /** Recorded billing and entitlement state of a tenant (everything a removal must not touch). */
  const billingState = async (t: string) => {
    const q = async (sql: string) => (await pg.query(sql, [t])).rows.map((r) => r.j as string);
    return {
      subscriptions: await q(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE tenant_id = $1 ORDER BY id`),
      entitlements: await q(`SELECT (capability::text) j FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY capability`),
      billing_events: await q(`SELECT row_to_json(e)::text j FROM subscription."BillingEvent" e WHERE tenant_id = $1 ORDER BY id`),
      flags: await q(`SELECT row_to_json(f)::text j FROM subscription."BillingReconciliationFlag" f WHERE tenant_id = $1 ORDER BY id`),
      checkout_intents: await q(`SELECT row_to_json(c)::text j FROM subscription."CheckoutIntent" c WHERE tenant_id = $1 ORDER BY id`),
      usage: await q(`SELECT row_to_json(u)::text j FROM subscription."AllowanceUsage" u WHERE tenant_id = $1 ORDER BY id`),
    };
  };
  const send = (t: string, send_key: string) => h.allowance.reserve({ tenant_id: t, product_key: 'sign', allowance_key: KEY, send_key, at: clock });

  it('A8-ARCH-1 (TD-A8-6) the overlay alters only Aramo\'s access interpretation: the Stripe-owned row (status PAST_DUE and every provider-sourced field) is byte-identical before, after apply and after removal', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRowFull(t);
    const before = await rowJson(sub);
    const providerFields = async () =>
      (await pg.query(`SELECT status, grace_until, billing_provider, billing_account_ref, billing_subscription_ref, current_period_end, cancel_at_period_end, provider_state_at, activated_by, ended_at, plan_id, plan_version_id FROM subscription."TenantSubscription" WHERE id = $1`, [sub])).rows[0];
    const fieldsBefore = await providerFields();
    expect(fieldsBefore.status).toBe('PAST_DUE');
    const applied = await extend(t, sub, 7);
    if (applied.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    expect(await rowJson(sub)).toBe(before);
    expect(await providerFields()).toEqual(fieldsBefore);
    expect((await h.allowance.getStatus(t, 'sign', KEY, clock)).subscribed).toBe(true); // Aramo's interpretation only
    clock = new Date(T0.getTime() + 3_600_000);
    await removeExtension(t, applied.extension.id);
    expect(await rowJson(sub)).toBe(before);
    expect(await providerFields()).toEqual(fieldsBefore);
    expect((await providerFields()).status).toBe('PAST_DUE');
  });

  it('A8-ARCH-2 (TD-A8-5) removal is recalculated IMMEDIATELY: a send admitted under the overlay; the very next allowance decision after the removal applies refuses it; while another unremoved overlay still covers the instant it still admits', async () => {
    // Sole overlay: admitted → removed → the next decision refuses.
    clock = T0;
    const t1 = await newTenant(pg);
    const sub1 = await stripeRow(t1);
    expect((await send(t1, 'arch2-pre')).ok).toBe(false);
    const a1 = await extend(t1, sub1, 7);
    if (a1.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    expect((await send(t1, 'arch2-1')).ok).toBe(true);
    clock = new Date(T0.getTime() + 3_600_000);
    await removeExtension(t1, a1.extension.id);
    const refused = await send(t1, 'arch2-2');
    expect(refused).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED', status: { subscribed: false, state: 'PAST_DUE' } });

    // Two overlays (bounded A + Finance-approved B): removing A still admits under B; removing B refuses.
    clock = T0;
    const t2 = await newTenant(pg);
    const sub2 = await stripeRow(t2);
    const a = await extend(t2, sub2, 7);
    if (a.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    const esc = await extend(t2, sub2, 20); // FREQUENCY + LENGTH → Finance
    expect(esc.outcome).toBe('ESCALATED');
    expect((await approveAndApply(esc.request.id)).request.state).toBe('APPLIED');
    const b = (await overlays(t2)).find((o) => o.change_request_id === esc.request.id);
    expect(b).toMatchObject({ is_exception: false, removed_at: null });
    clock = new Date(T0.getTime() + 3_600_000);
    await removeExtension(t2, a.extension.id);
    expect((await send(t2, 'arch2-b-1')).ok).toBe(true);
    clock = new Date(T0.getTime() + 2 * 3_600_000);
    await removeExtension(t2, b.id as string);
    expect(await send(t2, 'arch2-b-2')).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
  });

  it('A8-ARCH-3 (TD-A8-5) removal is audited and governed (support_admin requests, Finance approves; no self-approval, no apply before approval, no other applier) and leaves recorded billing and entitlement state untouched', async () => {
    clock = T0;
    const t = await newTenant(pg);
    const sub = await stripeRowFull(t);
    for (const c of ['core', 'sign']) await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [t, c]);
    await pg.query(`INSERT INTO subscription."BillingEvent" (id, provider, provider_event_id, event_type, event_created_at, tenant_id, outcome, detail) VALUES (gen_random_uuid(), 'STRIPE', $2, 'invoice.payment_failed', '2026-10-24T08:00:00Z', $1, 'APPLIED', 'past due')`, [t, `evt_${t}`]);
    await pg.query(`INSERT INTO subscription."BillingReconciliationFlag" (id, tenant_id, provider, subscription_ref, reason) VALUES (gen_random_uuid(), $1, 'STRIPE', $2, 'domain_not_authoritative')`, [t, `sub_${sub}`]);
    await pg.query(`INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, status) SELECT gen_random_uuid(), $1, 'owner-user-1', p.id, 'STRIPE', 'EXPIRED' FROM subscription."Plan" p WHERE p.key = $2`, [t, BUSINESS]);
    const applied = await extend(t, sub, 7);
    if (applied.outcome !== 'APPLIED') throw new Error('expected APPLIED');
    expect((await send(t, 'arch3-1')).ok).toBe(true);
    const before = await billingState(t);

    clock = new Date(T0.getTime() + 3_600_000);
    const r = await h.changeRequests.create(as(SA, 'support_admin'), { action_type: 'SUPPORT_EXTENSION', tenant_id: t, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: applied.extension.id }, reason: 'Extension no longer warranted', idempotency_key: key() }, A6_CTX);
    expect(r.request).toMatchObject({ kind: 'NORMAL', required_chain: { rule: 'FINANCE_ONLY', steps: [{ role_key: 'finance_admin' }] } });
    // Only support_admin requests (A1: platform:subscription:support).
    await expect(h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'SUPPORT_EXTENSION', tenant_id: t, product_key: 'sign', payload: { operation: 'REMOVE', support_extension_id: applied.extension.id }, reason: 'x', idempotency_key: key() }, A6_CTX)).rejects.toMatchObject({ code: 'REQUESTER_SCOPE_MISSING' });
    await h.changeRequests.submit(as(SA, 'support_admin'), r.request.id, A6_CTX);
    expect(await outcome(h.apply.apply(as(SA, 'support_admin'), r.request.id, A6_CTX))).toBe('REFUSED:NOT_APPROVED');
    await expect(h.changeRequests.approve(as(SA, 'support_admin'), r.request.id, { step_index: 0 }, A6_CTX)).rejects.toMatchObject({ refusal: 'SELF_APPROVAL' });
    expect((await overlays(t))[0].removed_at).toBeNull();
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    // Merge train TD-MERGE-31 (Lead: flip A8-ARCH-3): A6-R refuses the non-requester with NOT_REQUESTER and
    // audits the refusal (exactly one COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED row for this attempt).
    expect(await outcome(h.apply.apply(as(FA, 'finance_admin'), r.request.id, A6_CTX))).toBe('ERROR:NOT_REQUESTER:not_requester');
    const out = await h.apply.apply(as(SA, 'support_admin'), r.request.id, A6_CTX);
    expect(out.request.state).toBe('APPLIED');
    expect(out.application).toMatchObject({ action_type: 'SUPPORT_EXTENSION', subscription_id: sub, capabilities: [], capabilities_inserted: [] });

    // Audited: the full trail, with the approver evidence and no exception flag.
    const ev = await events(r.request.id);
    expect(ev.map((e) => e.event_type)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED',
      'COMMERCIAL_APPROVAL_REFUSED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      // the finance_admin apply attempt: exactly ONE refusal row (A6-R audits every refusal)
      'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED',
      'SUPPORT_EXTENSION_REMOVED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    expect(ev.some((e) => e.is_exception)).toBe(false);
    expect(ev[6]).toMatchObject({ event_type: 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED' });
    expect((ev[6]?.payload as { refusal?: string } | undefined)?.refusal).toBe('NOT_REQUESTER');
    expect(ev[7]?.payload).toMatchObject({ support_extension_id: applied.extension.id, subscription_id: sub, days: 7 });
    expect(ev[8]?.payload).toMatchObject({ outcome: 'APPLIED', kind: 'NORMAL', requested_by: SA, approvals: [{ step_index: 0, approver_user_id: FA }] });
    const roles = (await pg.query(`SELECT actor_id, actor_role_keys FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'SUPPORT_EXTENSION_REMOVED'`, [r.request.id])).rows[0];
    expect(roles).toEqual({ actor_id: SA, actor_role_keys: ['support_admin'] });
    // The removal is recorded on the overlay; the original apply evidence is untouched.
    const [o] = await overlays(t);
    expect(o).toMatchObject({ removed_by: SA, remove_change_request_id: r.request.id, change_request_id: applied.request.id, is_exception: true, days: 7 });
    expect((await events(applied.request.id)).map((e) => e.event_type)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED', 'SUPPORT_EXTENSION_EXCEPTION_APPLIED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    // No bypass of recorded billing or entitlement state.
    expect(await billingState(t)).toEqual(before);
    expect((await send(t, 'arch3-2')).ok).toBe(false);
  });

  it('A8-G1-1 every A8 path above ran under the Stripe-owned-row tripwire, and the tripwire is live (a direct write raises)', async () => {
    const t = await newTenant(pg);
    const sub = await stripeRow(t);
    expect(await raises(`UPDATE subscription."TenantSubscription" SET grace_until = now() WHERE id = $1`, [sub])).toContain('A8 TRIPWIRE: UPDATE');
  });
});
