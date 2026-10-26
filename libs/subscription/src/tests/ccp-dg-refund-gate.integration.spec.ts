import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingCommandError } from '../lib/billing/billing-command.service.js';
import { BillingAdjustmentRefusedError, REFUND_EXECUTION_FLAG } from '../lib/commercial/commercial-billing-adjustment.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyGovernanceService } from '../lib/commercial/commercial-policy-governance.service.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { REFUND_DISPATCH_REFUSED_EVENT } from '../lib/commercial/refund-execution-gate.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { POLICY_V1, addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, as, newTenant, rawSubscription } from './support/ccp-a6.js';
import { type C4Harness, c4Harness, refundPayload } from './support/ccp-c4.js';
import { TEST_REFUND_KEYS, TEST_REFUND_POLICY_REF, activatePolicyContent, activePolicyId, reactivatePolicy, v1With } from './support/ccp-dg.js';

// CCP-DG (Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED RX-1…RX-11; the C4-P
// successor) — the refund dual gate on real Postgres 17 with the real change-request, apply, command,
// lifecycle and inbox services (the one shared C4 harness); Stripe is the fake (no network, no key),
// whose call log is the oracle of "zero provider calls". Test IDs are cited by
// doc/ccp/slices/CCP-DG-acceptance.md:
//   DG-I-1  production configuration (v1, no refund keys): refused whatever the switch
//   DG-I-2  the 2 × 2 independence matrix at the apply (RX-7)
//   DG-I-3  snapshot vs current refund identity (RX-6), unrelated policy changes not blocking
//   DG-I-4  revocation (RX-9)
//   DG-I-5  RX-8 at create
//   DG-I-6  the re-arm is gated (apply re-arm and the runbook retry)
//   DG-I-7  the dispatcher re-checks both gates immediately before the first provider write
//   DG-I-8  RX-10: webhook, reconciliation, recording a confirmed refund and recovery are ungated
//   DG-I-9  the draft editor (RX-11)

const T0 = new Date('2026-10-27T12:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-DG the refund dual gate (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let probe: Client;
  let prisma: PrismaService;
  let h: C4Harness;
  let OPS: string;
  let FA: string;
  let PO: string;
  /** v1 + the test refund keys (gate 2 approved). */
  let RELEASED: string;
  let now = T0;
  let keyN = 0;
  let evtN = 0;
  const key = () => `dg-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_dg_${String(++evtN).padStart(6, '0')}`;
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
    FA = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    RELEASED = await activatePolicyContent(pg, v1With(TEST_REFUND_KEYS));
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
  const auditOf = async (cr: string, type: string) => (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = $2 ORDER BY created_at, id`, [cr, type])).rows.map((r) => r.payload as Record<string, unknown>);
  const refusedRows = (cr: string) => auditOf(cr, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED');
  /** Every fake-Stripe call naming this invoice (writes, effect reads and payment-picture reads). */
  const callsOn = (inv: string) => h.billing.adjustmentCalls.filter((c) => c.ref === inv).length;
  const writesOn = (inv: string) => h.billing.adjustmentCalls.filter((c) => c.ref === inv && c.op === 'executeAdjustment').length;
  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof BillingAdjustmentRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialChangeRequestError) return `${e.code}:${String(e.details['reason'] ?? '')}`;
      if (e instanceof BillingCommandError) return `COMMAND:${e.code}`;
      throw e;
    }
  }
  const withSwitch = async <T>(f: () => Promise<T>): Promise<T> => {
    process.env[REFUND_EXECUTION_FLAG] = '1';
    try {
      return await f();
    } finally {
      delete process.env[REFUND_EXECUTION_FLAG];
    }
  };
  /** Runs `f` with `id` ACTIVE, then restores the version that was ACTIVE before. */
  async function under<T>(id: string, f: () => Promise<T>): Promise<T> {
    const before = await activePolicyId(pg);
    await reactivatePolicy(pg, id);
    try {
      return await f();
    } finally {
      await reactivatePolicy(pg, before);
    }
  }
  /** A self-service tenant whose invoice the fake knows. */
  async function paid(): Promise<{ t: string; inv: string }> {
    const t = await newTenant(pg);
    const s = h.billing.state(t, randomUUID());
    await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    const inv = `in_dg${String(++keyN).padStart(6, '0')}`;
    h.billing.invoices.set(inv, { account_ref: `acct_${t}` });
    return { t, inv };
  }
  const create = (t: string, payload: Record<string, unknown>) =>
    h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'REFUND', tenant_id: t, product_key: 'sign', payload, reason: 'dg refund', idempotency_key: key() }, A6_CTX);
  /** A REFUND created (snapshotting the ACTIVE policy), submitted and approved Finance → Owner. */
  async function approvedRefund(amount = 1_000, extra: Record<string, unknown> = {}): Promise<{ id: string; t: string; inv: string }> {
    const p = await paid();
    const r = await create(p.t, refundPayload(amount, p.inv, extra));
    const id = r.request.id;
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    await h.changeRequests.approve(as(PO, 'platform_owner'), id, { step_index: 1 }, A6_CTX);
    expect((await reqRow(id)).state).toBe('APPROVED');
    return { id, ...p };
  }
  const applyAs = (id: string) => h.adjustments.apply(as(OPS, 'commercial_ops'), id, A6_CTX);
  const dispatch = () => h.commands.dispatchDue(now);
  const deliverObject = (object_ref: string) => h.inbox.receive({ id: evtId(), type: 'refund.updated', created: now, subscription_ref: null, object_ref }, 'sign', now);
  /** Expect a refused apply: the code, nothing changed, no command, zero provider calls, exactly one more APPLY_REFUSED row. */
  async function expectRefusedApply(r: { id: string; inv: string }, code: string, gate_2?: string): Promise<void> {
    const before = await reqRow(r.id);
    const calls = callsOn(r.inv);
    const rows = (await refusedRows(r.id)).length;
    expect(await refusal(applyAs(r.id))).toBe(`REFUSED:${code}`);
    const after = await reqRow(r.id);
    expect([after.state, after.apply_attempts]).toEqual([before.state, before.apply_attempts]);
    expect(callsOn(r.inv) - calls).toBe(0);
    const refused = await refusedRows(r.id);
    expect(refused).toHaveLength(rows + 1);
    expect(refused[refused.length - 1]).toMatchObject({ action_type: 'REFUND', refusal: code, ...(gate_2 !== undefined ? { detail: { gate_2 } } : {}) });
  }

  // ---- DG-I-1 production configuration -----------------------------------------------------

  it('DG-I-1 production configuration (only v1 ACTIVE, no refund keys): a REFUND is accepted as a proposal, approved, and its apply is refused with the switch OFF (REFUND_EXECUTION_NOT_RELEASED) AND with it ON (REFUND_POLICY_NOT_APPROVED); zero provider calls; one audit row per refusal', async () => {
    await under(POLICY_V1, async () => {
      const r = await approvedRefund(2_000, { refund_policy_ref: 'aramo-refund-policy@v1-draft' });
      expect((await reqRow(r.id)).policy_version_id).toBe(POLICY_V1);
      const calls = callsOn(r.inv);
      await expectRefusedApply(r, 'REFUND_EXECUTION_NOT_RELEASED', 'ACTIVE_POLICY_NOT_ENABLED');
      await withSwitch(() => expectRefusedApply(r, 'REFUND_POLICY_NOT_APPROVED', 'ACTIVE_POLICY_NOT_ENABLED'));
      expect(await commandsOf(r.id)).toEqual([]);
      expect(await refusedRows(r.id)).toHaveLength(2);
      expect(callsOn(r.inv) - calls).toBe(0);
      expect(await h.adjustments.view(r.id)).toMatchObject({ refund_execution_disabled: true });
      await withSwitch(async () => expect(await h.adjustments.view(r.id)).toMatchObject({ refund_execution_disabled: true }));
    });
  });

  // ---- DG-I-2 independence --------------------------------------------------------------------

  it('DG-I-2 the 2 × 2 matrix at the apply (RX-7): switch on/off × policy enabled/not — exactly one combination proceeds; activating a policy never overrides the switch and the switch never bypasses the policy; every refusal makes zero provider calls and one audit row', async () => {
    const NOT_ENABLED = await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    await reactivatePolicy(pg, RELEASED);
    const outcomes: string[] = [];
    for (const switch_on of [false, true]) {
      for (const [label, policy] of [
        ['enabled', RELEASED],
        ['not_enabled', NOT_ENABLED],
      ] as const) {
        await under(policy, async () => {
          const r = await approvedRefund(1_000);
          const run = async () => {
            const calls = callsOn(r.inv);
            const res = await refusal(applyAs(r.id));
            if (res === 'OK') {
              expect(await commandsOf(r.id)).toHaveLength(1);
              expect((await reqRow(r.id)).state).toBe('APPLYING');
            } else {
              expect((await reqRow(r.id)).state).toBe('APPROVED');
              expect(await commandsOf(r.id)).toEqual([]);
              expect(callsOn(r.inv) - calls).toBe(0);
              expect(await refusedRows(r.id)).toHaveLength(1);
            }
            outcomes.push(`${switch_on ? 'on' : 'off'}/${label}=${res}`);
          };
          if (switch_on) await withSwitch(run);
          else await run();
        });
      }
    }
    expect(outcomes).toEqual(['off/enabled=REFUSED:REFUND_EXECUTION_NOT_RELEASED', 'off/not_enabled=REFUSED:REFUND_EXECUTION_NOT_RELEASED', 'on/enabled=OK', 'on/not_enabled=REFUSED:REFUND_POLICY_NOT_APPROVED']);
    expect(outcomes.filter((o) => o.endsWith('=OK'))).toHaveLength(1);
  });

  // ---- DG-I-3 snapshot vs current ----------------------------------------------------------------

  it('DG-I-3 snapshot vs current (RX-6): an unrelated policy change (other thresholds, other checksum, the same refund identity) does not block; another refund identity (sha or ref) is refused REFUND_POLICY_NOT_APPROVED in both directions', async () => {
    const a = await approvedRefund(1_000); // snapshotted under RELEASED
    const b = await approvedRefund(1_000);
    const c = await approvedRefund(1_000);
    const UNRELATED = await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, credit_escalation_threshold_minor: 100_000, apply_expiry_hours: 720 }));
    const SNAP = await one(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [RELEASED]);
    const CUR = await one(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [UNRELATED]);
    expect(CUR.content_checksum).not.toBe(SNAP.content_checksum);
    await withSwitch(async () => {
      expect((await applyAs(a.id)).request.state).toBe('APPLYING');
      expect((await reqRow(a.id)).policy_version_id).toBe(RELEASED);
    });
    const OTHER_SHA = await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_policy_sha256: 'b'.repeat(64) }));
    await withSwitch(() => expectRefusedApply(b, 'REFUND_POLICY_NOT_APPROVED', 'REFUND_POLICY_IDENTITY_CHANGED'));
    // A request raised under the other identity, with the original identity ACTIVE again: refused too.
    const d = await approvedRefund(1_000);
    expect((await reqRow(d.id)).policy_version_id).toBe(OTHER_SHA);
    await reactivatePolicy(pg, RELEASED);
    await withSwitch(() => expectRefusedApply(d, 'REFUND_POLICY_NOT_APPROVED', 'REFUND_POLICY_IDENTITY_CHANGED'));
    await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_policy_ref: 'ARAMO-COM-REFUND-POL-TEST@1.1' }));
    await withSwitch(() => expectRefusedApply(c, 'REFUND_POLICY_NOT_APPROVED', 'REFUND_POLICY_IDENTITY_CHANGED'));
    await reactivatePolicy(pg, RELEASED);
    // No provider write for a, b, c or d yet (a is queued, not dispatched; the refusals made no call at all).
    for (const r of [a, b, c, d]) expect(writesOn(r.inv)).toBe(0);
    // The queued command of `a` is dispatched under the original identity: proceeds (one write).
    await withSwitch(() => dispatch());
    expect(writesOn(a.inv)).toBe(1);
  });

  // ---- DG-I-4 revocation ----------------------------------------------------------------------

  it('DG-I-4 revocation (RX-9): activating a version with refund_execution_enabled false, or without the keys, stops new execution for a request snapshotted under the enabling version (REFUND_POLICY_NOT_APPROVED, zero provider calls); re-activating the enabling version lets it apply', async () => {
    const r = await approvedRefund(1_000);
    await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    await withSwitch(() => expectRefusedApply(r, 'REFUND_POLICY_NOT_APPROVED', 'ACTIVE_POLICY_NOT_ENABLED'));
    await activatePolicyContent(pg, v1With());
    await withSwitch(() => expectRefusedApply(r, 'REFUND_POLICY_NOT_APPROVED', 'ACTIVE_POLICY_NOT_ENABLED'));
    await reactivatePolicy(pg, POLICY_V1);
    await withSwitch(() => expectRefusedApply(r, 'REFUND_POLICY_NOT_APPROVED', 'ACTIVE_POLICY_NOT_ENABLED'));
    await reactivatePolicy(pg, RELEASED);
    await withSwitch(async () => expect((await applyAs(r.id)).request.state).toBe('APPLYING'));
    expect(await refusedRows(r.id)).toHaveLength(3);
    await withSwitch(() => dispatch());
    expect(writesOn(r.inv)).toBe(1);
  });

  // ---- DG-I-5 RX-8 at create ------------------------------------------------------------------------

  it('DG-I-5 RX-8 at create: under a policy declaring the keys (enabled or revoked) a REFUND naming another refund policy is refused REFUND_POLICY_REF_MISMATCH before any provider read, nothing created; under a policy without the keys the reference is a proposal only, and execution stays refused at apply (SNAPSHOT_POLICY_NOT_ENABLED)', async () => {
    const p = await paid();
    const calls = callsOn(p.inv);
    const mismatch = refundPayload(1_000, p.inv, { refund_policy_ref: 'ARAMO-COM-REFUND-POL-999@9.9' });
    const err = await create(p.t, mismatch).then(
      () => null,
      (e: unknown) => e as CommercialChangeRequestError,
    );
    expect(err).toBeInstanceOf(CommercialChangeRequestError);
    expect([err?.code, err?.details['reason'], err?.details['codes'], err?.details['declared_ref']]).toEqual(['INVALID_INPUT', 'refund_policy_ref_mismatch', ['REFUND_POLICY_REF_MISMATCH'], TEST_REFUND_POLICY_REF]);
    expect(await refusal(create(p.t, refundPayload(1_000, p.inv, { refund_policy_ref: 'aramo-refund-policy@v1-draft' })))).toBe('INVALID_INPUT:refund_policy_ref_mismatch');
    await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    expect(await refusal(create(p.t, mismatch))).toBe('INVALID_INPUT:refund_policy_ref_mismatch');
    await reactivatePolicy(pg, RELEASED);
    expect(callsOn(p.inv) - calls).toBe(0);
    expect((await one(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1`, [p.t])).n).toBe(0);
    // Matching reference: created (one picture read for the remainder).
    expect((await create(p.t, refundPayload(1_000, p.inv))).request.payload).toMatchObject({ refund_policy_ref: TEST_REFUND_POLICY_REF });
    // Under v1 (no keys): any well-formed reference is a proposal; the apply is refused by gate 2.
    const proposal = await under(POLICY_V1, () => approvedRefund(1_000, { refund_policy_ref: 'ARAMO-COM-REFUND-POL-999@9.9' }));
    expect(await activePolicyId(pg)).toBe(RELEASED);
    await withSwitch(() => expectRefusedApply(proposal, 'REFUND_POLICY_NOT_APPROVED', 'SNAPSHOT_POLICY_NOT_ENABLED'));
  });

  // ---- DG-I-6 the re-arm ----------------------------------------------------------------------------

  it('DG-I-6 the re-arm is gated: a FAILED refund command is re-armed neither by the requester apply nor by the runbook retry while the switch is off (REFUND_EXECUTION_NOT_RELEASED) or the policy is revoked (REFUND_POLICY_NOT_APPROVED); with both gates it is re-armed (the same command) and sent once', async () => {
    const r = await approvedRefund(1_000);
    await withSwitch(async () => {
      await applyAs(r.id);
      h.billing.adjustmentFailures.set((await commandsOf(r.id))[0].id, { kind: 'refused', times: 1 });
      await dispatch();
    });
    const [cmd] = await commandsOf(r.id);
    expect(cmd).toMatchObject({ state: 'FAILED', last_error_code: 'PROVIDER_REFUSED' });
    const w = writesOn(r.inv);
    const calls = callsOn(r.inv);
    await expectRefusedApply(r, 'REFUND_EXECUTION_NOT_RELEASED');
    expect(await refusal(h.commands.retryFailed(cmd.id, now))).toBe('COMMAND:REFUND_EXECUTION_NOT_RELEASED');
    const revoked = await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    await withSwitch(async () => {
      await expectRefusedApply(r, 'REFUND_POLICY_NOT_APPROVED', 'ACTIVE_POLICY_NOT_ENABLED');
      expect(await refusal(h.commands.retryFailed(cmd.id, now))).toBe('COMMAND:REFUND_POLICY_NOT_APPROVED');
    });
    expect((await commandsOf(r.id))[0]).toMatchObject({ id: cmd.id, state: 'FAILED' });
    expect(callsOn(r.inv) - calls).toBe(0);
    expect(revoked).not.toBe(RELEASED);
    await reactivatePolicy(pg, RELEASED);
    await withSwitch(async () => {
      const out = await applyAs(r.id);
      expect(out.replayed).toBe(false);
      expect(await auditOf(r.id, 'COMMERCIAL_REFUND_REARMED')).toHaveLength(1);
      await dispatch();
    });
    const cmds = await commandsOf(r.id);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ id: cmd.id, state: 'PENDING_PROVIDER' });
    expect(writesOn(r.inv) - w).toBe(1);
  });

  // ---- DG-I-7 the dispatcher -----------------------------------------------------------------------

  it('DG-I-7 immediately before the first provider dispatch: a command queued under both gates is FAILED with zero provider writes and no payment-picture read when the switch went off (REFUND_EXECUTION_NOT_RELEASED) or the policy was revoked (REFUND_POLICY_NOT_APPROVED), each with one COMMERCIAL_REFUND_DISPATCH_REFUSED audit row', async () => {
    const off = await approvedRefund(1_000);
    const revokedCase = await approvedRefund(1_000);
    await withSwitch(async () => {
      await applyAs(off.id);
      await applyAs(revokedCase.id);
    });
    const picturesBefore = (inv: string) => h.billing.adjustmentCalls.filter((c) => c.ref === inv && c.op === 'readPaymentPicture').length;
    const pOff = picturesBefore(off.inv);
    const pRev = picturesBefore(revokedCase.inv);
    // (a) the switch is off; the policy is approved
    await dispatch();
    expect((await commandsOf(off.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_EXECUTION_NOT_RELEASED' });
    expect((await commandsOf(revokedCase.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_EXECUTION_NOT_RELEASED' });
    expect(await auditOf(off.id, REFUND_DISPATCH_REFUSED_EVENT)).toEqual([expect.objectContaining({ action_type: 'REFUND', refusal: 'REFUND_EXECUTION_NOT_RELEASED', detail: { gate_1_released: false, gate_2: 'APPROVED' } })]);
    // (b) re-armed with both gates, then the policy is revoked before the dispatcher runs (switch on)
    await withSwitch(() => applyAs(revokedCase.id));
    expect((await commandsOf(revokedCase.id))[0].state).toBe('PENDING');
    await activatePolicyContent(pg, v1With({ ...TEST_REFUND_KEYS, refund_execution_enabled: false }));
    try {
      await withSwitch(() => dispatch());
    } finally {
      await reactivatePolicy(pg, RELEASED);
    }
    expect((await commandsOf(revokedCase.id))[0]).toMatchObject({ state: 'FAILED', last_error_code: 'REFUND_POLICY_NOT_APPROVED' });
    const rows = await auditOf(revokedCase.id, REFUND_DISPATCH_REFUSED_EVENT);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ refusal: 'REFUND_POLICY_NOT_APPROVED', detail: { gate_1_released: true, gate_2: 'ACTIVE_POLICY_NOT_ENABLED' } });
    for (const r of [off, revokedCase]) expect(writesOn(r.inv)).toBe(0);
    expect(picturesBefore(off.inv) - pOff).toBe(0);
    expect(picturesBefore(revokedCase.inv) - pRev).toBe(0);
    expect((await reqRow(off.id)).state).toBe('APPLYING');
  });

  // ---- DG-I-8 RX-10 -----------------------------------------------------------------------------------

  it('DG-I-8 RX-10 with BOTH gates off (switch off, v1 ACTIVE): the refund webhook confirms, the read-only re-fetch records a confirmed refund as applied, the dispatcher still reconciles a lost response, and the governed resolution closes a refund proven not executed or records a confirmed one — no gate refusal, no new provider write', async () => {
    const t0 = now;
    try {
      const hook = await approvedRefund(1_000);
      const lost = await approvedRefund(2_000);
      const resolvedConfirmed = await approvedRefund(3_000);
      const neverRan = await approvedRefund(4_000);
      await withSwitch(async () => {
        for (const r of [hook, lost, resolvedConfirmed, neverRan]) await applyAs(r.id);
        h.billing.lostResponses.set((await commandsOf(lost.id))[0].id, 1);
        h.billing.lostResponses.set((await commandsOf(resolvedConfirmed.id))[0].id, 1);
        h.billing.adjustmentFailures.set((await commandsOf(neverRan.id))[0].id, { kind: 'refused', times: 1 });
        await dispatch();
      });
      // Both gates off from here.
      await reactivatePolicy(pg, POLICY_V1);
      expect(process.env[REFUND_EXECUTION_FLAG]).toBeUndefined();
      const writes = h.billing.writes;
      // webhook processing
      expect(await deliverObject((await commandsOf(hook.id))[0].provider_object_ref)).toMatchObject({ outcome: 'APPLIED' });
      expect((await reqRow(hook.id)).state).toBe('APPLIED');
      // governed resolution: a refund the re-fetch proves CONFIRMED is recorded APPLIED
      expect(await h.adjustments.resolveRefund(as(OPS, 'commercial_ops'), resolvedConfirmed.id, A6_CTX)).toMatchObject({ resolution: 'CONFIRMED', request: { state: 'APPLIED' } });
      // authorized terminal recovery: proven not found → WITHDRAWN
      expect(await h.adjustments.resolveRefund(as(OPS, 'commercial_ops'), neverRan.id, A6_CTX)).toMatchObject({ resolution: 'RESOLVED_NOT_EXECUTED', request: { state: 'WITHDRAWN' } });
      // the dispatcher's due retry re-reads first: the refund exists → recorded, never re-sent
      now = new Date(t0.getTime() + 5 * 60_000);
      await dispatch();
      expect((await commandsOf(lost.id))[0]).toMatchObject({ state: 'PENDING_PROVIDER', last_error_detail: 'already in effect at the provider' });
      // read-only reconciliation records the confirmed refund as applied
      await h.commands.reconcilePending('sign', now);
      expect((await reqRow(lost.id)).state).toBe('APPLIED');
      expect(h.billing.writes - writes).toBe(0);
      for (const r of [hook, lost, resolvedConfirmed, neverRan]) {
        expect(await refusedRows(r.id), r.id).toEqual([]);
        expect(await auditOf(r.id, REFUND_DISPATCH_REFUSED_EVENT), r.id).toEqual([]);
        expect(writesOn(r.inv), r.id).toBe(1);
      }
    } finally {
      now = t0;
      await reactivatePolicy(pg, RELEASED);
    }
  });

  // ---- DG-I-9 the draft editor ------------------------------------------------------------------------

  it('DG-I-9 the draft editor (RX-11): the three keys are set together on a DRAFT (audited per key); a partial, null or malformed edit is refused policy_value_invalid and changes nothing; false revokes; the drafted version, once ACTIVE, gates as authored', async () => {
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    const gov = new CommercialPolicyGovernanceService(prisma, policies, audit, new CommercialOperatorRepository(prisma, audit, policies), h.changeRequests);
    await reactivatePolicy(pg, POLICY_V1);
    const draft = await gov.createDraft(as(FA, 'finance_admin'), { source_version_id: POLICY_V1 }, A6_CTX);
    const upd = (content: Record<string, unknown>) => gov.updateDraft(as(FA, 'finance_admin'), draft.id, { content }, A6_CTX);
    const bad: Array<Record<string, unknown>> = [
      { refund_execution_enabled: true },
      { refund_policy_ref: TEST_REFUND_POLICY_REF, refund_policy_sha256: 'a'.repeat(64) },
      { ...TEST_REFUND_KEYS, refund_policy_ref: 'refund-policy@1.0' },
      { ...TEST_REFUND_KEYS, refund_policy_sha256: 'A'.repeat(64) },
      { ...TEST_REFUND_KEYS, refund_execution_enabled: null },
      { ...TEST_REFUND_KEYS, refund_execution_enabled: 'true' },
    ];
    for (const b of bad) expect(await refusal(upd(b)), JSON.stringify(b)).toBe('INVALID_INPUT:policy_value_invalid');
    const unchanged = await one(`SELECT content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [draft.id]);
    expect(unchanged.content_checksum).toBe(draft.content_checksum);
    const ok = await upd({ ...TEST_REFUND_KEYS });
    expect(ok.content).toMatchObject(TEST_REFUND_KEYS);
    const ev = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_POLICY_DRAFT_UPDATED' AND subject = $1 ORDER BY created_at, id`, [`commercial_policy_version:${draft.id}`])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ changed_keys: ['refund_execution_enabled', 'refund_policy_ref', 'refund_policy_sha256'], before: { refund_execution_enabled: null, refund_policy_ref: null, refund_policy_sha256: null }, after: TEST_REFUND_KEYS });
    // the keys stay all-or-none: once set, each can be changed alone (the document keeps all three)
    expect((await upd({ refund_execution_enabled: false })).content).toMatchObject({ ...TEST_REFUND_KEYS, refund_execution_enabled: false });
    expect((await upd({ refund_execution_enabled: true })).content).toMatchObject(TEST_REFUND_KEYS);
    // Activated (raw, test fixture; the governed path is POLICY_ACTIVATE), it gates as authored.
    await reactivatePolicy(pg, draft.id);
    try {
      const r = await approvedRefund(1_000);
      expect((await reqRow(r.id)).policy_version_id).toBe(draft.id);
      await withSwitch(async () => expect((await applyAs(r.id)).request.state).toBe('APPLYING'));
    } finally {
      await reactivatePolicy(pg, RELEASED);
    }
  });

  it('DG-TX-1 no provider call ran inside a local DB transaction across this spec', () => {
    expect(h.billing.probes).toBeGreaterThan(5);
    expect(h.billing.violations).toEqual([]);
  });
});
