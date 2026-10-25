import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commercialPolicyChecksum } from '@aramo/subscription';

// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs (TD-A3-19 precedent)
import { CCP_BUNDLES, grantRole, revokeAttestation, revokeRole } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';

import { ALL_ROLES, CCP_ROLES, CR, clock, concrete, declaredRoutes, out, startD4, type D4Harness } from './support/ccp-d4-harness.js';
import { ESCALATED, SCENARIOS, applyPath, approvalRows, approved, idOf, key, pending, policyDraft, requestState, settle, type Scenario } from './support/ccp-d4-scenarios.js';

const H = 3_600_000;
const APPLYABLE = SCENARIOS.filter((s) => s.apply === 'apply' || s.apply === 'convert');
const TWO_STEP: Scenario[] = [...SCENARIOS.filter((s) => s.chain.length === 2), ...ESCALATED];
const settled = <T,>(ps: Promise<T>[]) => Promise.all(ps);

// CCP-D4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D4; Charter §6.4 NC-1…NC-5) —
// the program-level RBAC negative controls, through the HTTP routes of the REAL platform-admin
// AppModule (real JwtAuthGuard + identity RBAC resolver + RolesGuard + services) on real Postgres.
// HALT condition: any negative control that passes when it should refuse.

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D4 program negative controls (real AppModule, real RBAC, real Postgres)', { timeout: 300_000 }, () => {
  let h: D4Harness;

  beforeAll(async () => {
    h = await startD4();
  }, 600_000);
  afterAll(async () => {
    await h?.stop();
  }, 120_000);

  it('D4-GATE-1 every /platform/commercial route the AppModule registers: no session 401; a tenant-tier token 403; super_admin 403 naming the route scope (no commercial authority); each CCP role is refused exactly when its A1 bundle lacks the route scope', async () => {
    const routes = declaredRoutes();
    const matrix: Record<string, Record<string, string>> = {};
    const violations: string[] = [];
    for (const r of routes) {
      const path = concrete(r.path);
      const row: Record<string, string> = {};
      const anon = await h.call(null, r.method, path, {});
      row['no_session'] = String(anon.status);
      if (anon.status !== 401) violations.push(`${r.method} ${r.path} no session → ${anon.status}`);
      const tier = await h.call('commercial_ops', r.method, path, {}, 'recruiter');
      row['tenant_tier'] = `${tier.status} ${tier.body?.error?.details?.reason ?? ''}`.trim();
      if (tier.status !== 403) violations.push(`${r.method} ${r.path} tenant tier → ${tier.status}`);
      for (const role of ALL_ROLES) {
        const res = await h.call(role, r.method, path, {});
        const gateRefused = res.status === 403 && Array.isArray(res.body?.error?.details?.missing_scopes);
        const holds = r.scopes.every((s) => (CCP_BUNDLES[role] ?? []).includes(s));
        row[role] = gateRefused ? `403 missing ${(res.body.error.details.missing_scopes as string[]).join(',')}` : `admitted (${res.status})`;
        if (holds && gateRefused) violations.push(`${r.method} ${r.path} ${role} holds ${r.scopes.join(',')} but was gate-refused`);
        if (!holds && !gateRefused) violations.push(`${r.method} ${r.path} ${role} lacks ${r.scopes.join(',')} but was admitted (${res.status})`);
        if (role === 'super_admin' && !gateRefused) violations.push(`${r.method} ${r.path} super_admin admitted (${res.status})`);
      }
      matrix[`${r.method} ${r.path} [${r.scopes.join(',')}]`] = row;
    }
    console.log(`D4-GATE-1 routes=${routes.length}\n${JSON.stringify(matrix, null, 1)}`);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.scopes.length > 0), 'every CCP route declares @RequireScopes').toBe(true);
    expect(violations).toEqual([]);
  });

  it('D4-CREATE-1 every commercial action type: only the requester role creates (requester scope or live requester role); every other CCP role and super_admin are refused 403 and nothing is written (the tenant tier on this route: D4-GATE-1)', async () => {
    const results: Record<string, Record<string, string>> = {};
    const violations: string[] = [];
    for (const s of SCENARIOS) {
      const row: Record<string, string> = {};
      for (const role of [...ALL_ROLES].filter((r) => r !== s.requester)) {
        const before = Number((await h.pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n);
        const c = await s.create(h, role);
        const after = Number((await h.pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n);
        const reason = c.res.body?.['error'] as { code?: string; details?: { reason?: string; missing_scopes?: string[] } } | undefined;
        row[role] = `${c.res.status} ${reason?.details?.reason ?? (reason?.details?.missing_scopes ? `missing ${reason.details.missing_scopes.join(',')}` : '')}`.trim();
        if (c.res.status !== 403 || reason?.code !== 'INSUFFICIENT_PERMISSIONS') violations.push(`${s.action} ${role} → ${row[role]}`);
        if (after !== before) violations.push(`${s.action} ${role} wrote ${after - before} request row(s)`);
      }
      const ok = await s.create(h, s.requester);
      row[s.requester] = String(ok.res.status);
      if (ok.res.status !== 201) violations.push(`${s.action} requester ${s.requester} → ${ok.res.status} ${JSON.stringify(ok.res.body)}`);
      else if ((ok.res.body['request'] as { state: string }).state === 'DRAFT') await h.post(s.requester, `${CR}/${idOf(ok)}/withdraw`);
      results[s.action] = row;
    }
    console.log(`D4-CREATE-1\n${JSON.stringify(results, null, 1)}`);
    expect(violations).toEqual([]);
    expect(Object.keys(results)).toHaveLength(14);
  });

  it('D4-SELF-1 self-approval is refused on every action type, even when the requester ALSO holds every step role (one person holding several roles); the subject of a role change cannot approve it; no approval row is written', async () => {
    const results: Record<string, string> = {};
    for (const s of SCENARIOS) {
      const alias = `self-${s.action}`;
      await h.operator(alias, [...new Set([s.requester, ...s.stepRoles])]);
      const c = await pending(h, s, alias);
      const res = await h.post(alias, `${CR}/${c.id}/approvals`, { step_index: 0 });
      results[s.action] = out(res).join(' ');
      expect(out(res), s.action).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'SELF_APPROVAL']);
      expect(await approvalRows(h, c.id)).toEqual([]);
      expect(await requestState(h, c.id)).toBe('PENDING_APPROVAL');
      await h.post(alias, `${CR}/${c.id}/withdraw`);
    }
    console.log(`D4-SELF-1\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(14);
    expect(CCP_ROLES).toHaveLength(6);
  });

  /** Holders of `role` (user ids), live. */
  async function holders(role: string): Promise<string[]> {
    return (
      await h.pg.query(
        `SELECT m.user_id FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE r.key = $1 ORDER BY m.user_id`,
        [role],
      )
    ).rows.map((r) => r.user_id as string);
  }
  /** Revoke `role` from every holder except `keep` for the duration of `fn`, then restore. */
  async function suspended<T>(role: string, keep: string[], fn: () => Promise<T>): Promise<T> {
    const gone = (await holders(role)).filter((u) => !keep.includes(u));
    for (const u of gone) await revokeRole(h.pg, u, role);
    try {
      return await fn();
    } finally {
      for (const u of gone) await grantRole(h.pg, u, role);
    }
  }
  /**
   * The "applied" oracle for every applyable type: COMMERCIAL_CHANGE_REQUEST_APPLIED audit events of
   * the request (A6 / A7 / A8, B2-backend, B5-R policy and C2 conversion applies each write exactly
   * one), plus every application row (A6 family and catalog) the request owns.
   */
  const applications = async (id: string) =>
    Number(
      (
        await h.pg.query(
          `SELECT (SELECT count(*) FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLIED')::int AS n`,
          [id],
        )
      ).rows[0].n,
    );
  const effectRows = async (id: string) =>
    Number(
      (
        await h.pg.query(
          `SELECT ((SELECT count(*) FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1) + (SELECT count(*) FROM subscription."CommercialCatalogApplication" WHERE change_request_id = $1))::int AS n`,
          [id],
        )
      ).rows[0].n,
    );
  const withdraw = (s: Scenario, id: string, who = s.requester) => settle(h, s, id, who);

  it('D4-NC1 concurrent approval on every action type (and on step 1 of every two-step chain): 4 distinct eligible humans race one step; exactly one 201, three 409; one approval row per step; no double-advance', async () => {
    for (let i = 1; i <= 4; i++) {
      await h.operator(`race_fin_${i}`, ['finance_admin']);
      await h.operator(`race_own_${i}`, ['platform_owner']);
    }
    const racers = (role: string) => [1, 2, 3, 4].map((i) => `race_${role === 'finance_admin' ? 'fin' : 'own'}_${i}`);
    const results: Record<string, string> = {};
    for (const s of [...SCENARIOS, ...ESCALATED.map((e) => ({ ...e, action: `${e.action}(escalated)` }))]) {
      const c = await pending(h, s);
      for (const [step, role] of s.stepRoles.entries()) {
        const res = await settled(racers(role).map((who) => h.post(who, `${CR}/${c.id}/approvals`, { step_index: step })));
        const statuses = res.map((r) => r.status).sort();
        const refusals = res.filter((r) => r.status !== 201).map((r) => out(r)[2]);
        results[`${s.action} step ${step}`] = `${statuses.join(',')} losers=${[...new Set(refusals)].join('|')}`;
        expect(statuses, `${s.action} step ${step}`).toEqual([201, 409, 409, 409]);
        expect((await approvalRows(h, c.id)).length, `${s.action} step ${step}`).toBe(step + 1);
      }
      expect(await requestState(h, c.id), s.action).not.toBe('PENDING_APPROVAL');
      await withdraw(s, c.id);
    }
    console.log(`D4-NC1\n${JSON.stringify(results, null, 1)}`);
    // 11 one-step + 3 two-step action types, plus the 2 escalated (two-step) money actions.
    expect(Object.keys(results)).toHaveLength(11 + 3 * 2 + 2 * 2);
  });

  it('D4-NC1-APPLY concurrent apply by the requester on every applyable type: 3 parallel applies produce exactly one application row and the request ends applied once', async () => {
    const results: Record<string, string> = {};
    for (const s of APPLYABLE) {
      const c = await approved(h, s);
      const res = await settled([1, 2, 3].map(() => h.post(s.requester, applyPath(s, c.id))));
      const summary = res.map((r) => (r.status === 200 ? (r.body?.replayed ? '200r' : '200') : out(r).join(' '))).sort();
      results[s.action] = summary.join(', ');
      expect(res.filter((r) => r.status === 200 && r.body?.replayed === false), `${s.action} ${summary.join(', ')}`).toHaveLength(1);
      expect(await applications(c.id), s.action).toBe(1);
    }
    console.log(`D4-NC1-APPLY\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(10);
  });

  it('D4-NC2 one person holding several roles fills at most one step: a finance_admin + platform_owner user, and a user holding all 6 CCP roles, fill step 0 of every two-step chain and are refused step 1 (USER_ALREADY_APPROVED); a distinct owner completes', async () => {
    await h.operator('fin_own', ['finance_admin', 'platform_owner']);
    await h.operator('all_six', [...CCP_ROLES]);
    const results: Record<string, string> = {};
    for (const multi of ['fin_own', 'all_six']) {
      for (const s of TWO_STEP) {
        const c = await pending(h, s);
        expect((await h.post(multi, `${CR}/${c.id}/approvals`, { step_index: 0 })).status, `${multi} ${s.action} step 0`).toBe(201);
        const second = await h.post(multi, `${CR}/${c.id}/approvals`, { step_index: 1 });
        results[`${multi} ${s.action}(${JSON.stringify(s.chain)})`] = out(second).join(' ');
        expect(out(second), `${multi} ${s.action}`).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'USER_ALREADY_APPROVED']);
        expect(await approvalRows(h, c.id)).toHaveLength(1);
        expect((await h.post('platform_owner_2', `${CR}/${c.id}/approvals`, { step_index: 1 })).status).toBe(201);
        expect(await requestState(h, c.id)).toBe('APPROVED');
        await withdraw(s, c.id);
      }
    }
    console.log(`D4-NC2\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(2 * 5);
  });

  it('D4-NC2-D9 the D9 attestation: on every action type an unattested holder of the step role and a holder whose attestation was revoked are refused NOT_HUMAN; a second account for an already-attested human cannot be attested (unique active human_ref)', async () => {
    const results: Record<string, string> = {};
    for (const s of SCENARIOS) {
      const role = s.stepRoles[0] as string;
      const un = await h.operator(`unattested-${s.action}`, [role], { attested: false });
      const rev = await h.operator(`revoked-${s.action}`, [role]);
      await revokeAttestation(h.pg, rev);
      const c = await pending(h, s);
      const a = await h.post(`unattested-${s.action}`, `${CR}/${c.id}/approvals`, { step_index: 0 });
      const b = await h.post(`revoked-${s.action}`, `${CR}/${c.id}/approvals`, { step_index: 0 });
      results[s.action] = `${out(a).join(' ')} / ${out(b).join(' ')}`;
      expect(out(a), `${s.action} unattested`).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'NOT_HUMAN']);
      expect(out(b), `${s.action} revoked`).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'NOT_HUMAN']);
      expect(await approvalRows(h, c.id)).toEqual([]);
      expect(un).not.toBe(rev);
      await withdraw(s, c.id);
    }
    await h.operator('human_x_account_1', ['finance_admin'], { human: 'human:x' });
    await expect(h.operator('human_x_account_2', ['platform_owner'], { human: 'human:x' })).rejects.toThrow(/CommercialOperatorAttestation_active_human_key|duplicate key/);
    console.log(`D4-NC2-D9\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(14);
  });

  it('D4-NC3 stale chains at approve: (a) on every action type the request expires at exactly expires_at (1 ms before is admitted); (b) a chain no distinct eligible human can still fill is refused CCP_NOT_BOOTSTRAPPED on every action type, state unchanged', async () => {
    const results: Record<string, string> = {};
    try {
      const exp = async (id: string) => (await h.pg.query(`SELECT expires_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].expires_at as Date;
      for (const s of SCENARIOS) {
        // One request at a time (one open POLICY_ACTIVATE at a time): the late one first.
        clock.fixed = new Date(Date.now() - 200 * H);
        const late = await pending(h, s);
        clock.fixed = await exp(late.id);
        const refused = await h.post(s.chain[0] as string, `${CR}/${late.id}/approvals`, { step_index: 0 });
        const lateState = await requestState(h, late.id);
        clock.fixed = new Date(Date.now() - 200 * H);
        const early = await pending(h, s);
        clock.fixed = new Date((await exp(early.id)).getTime() - 1);
        const ok = await h.post(s.chain[0] as string, `${CR}/${early.id}/approvals`, { step_index: 0 });
        results[`${s.action} expiry`] = `-1ms ${ok.status} / at ${out(refused).join(' ')} → ${lateState}`;
        expect(ok.status, `${s.action} -1ms ${JSON.stringify(ok.body)}`).toBe(201);
        expect(out(refused), `${s.action} at expires_at`).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'EXPIRED']);
        expect(lateState, s.action).toBe('EXPIRED');
        expect(await approvalRows(h, late.id)).toEqual([]);
        clock.fixed = null;
        await withdraw(s, early.id);
      }
    } finally {
      clock.fixed = null;
    }
    for (const s of SCENARIOS) {
      const c = await pending(h, s);
      // Step 0's role is held by nobody eligible: every other holder suspended (the requester and
      // the subject of a role change are excluded from the chain anyway).
      const keep = [h.user[s.requester] as string];
      const res = await suspended(s.stepRoles[0] as string, keep, () => h.post('read_only_auditor', `${CR}/${c.id}/approvals`, { step_index: 0 }));
      results[`${s.action} unsatisfiable`] = out(res).join(' ');
      expect(out(res)[0], s.action).toBe(409);
      expect(out(res)[1], s.action).toBe('CCP_NOT_BOOTSTRAPPED');
      expect(await requestState(h, c.id)).toBe('PENDING_APPROVAL');
      await withdraw(s, c.id);
    }
    // Step 1 of every two-step chain: after step 0 the only remaining owner is the step-0 signer.
    for (const s of TWO_STEP) {
      const c = await pending(h, s);
      expect((await h.post('fin_own', `${CR}/${c.id}/approvals`, { step_index: 0 })).status).toBe(201);
      const res = await suspended('platform_owner', [h.user['fin_own'] as string], () => h.post('read_only_auditor', `${CR}/${c.id}/approvals`, { step_index: 1 }));
      results[`${s.action} step 1 unsatisfiable`] = out(res).join(' ');
      expect(out(res).slice(0, 2), s.action).toEqual([409, 'CCP_NOT_BOOTSTRAPPED']);
      expect(await approvalRows(h, c.id)).toHaveLength(1);
      await withdraw(s, c.id);
    }
    console.log(`D4-NC3\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(14 + 14 + 5);
  });

  it('D4-NC4 role revoked between request and approval, on every action type and every step: eligibility is read live in the approve transaction (STEP_SCOPE_MISSING when the gate still admits; refused at the gate when the revoked role was the only one); no approval row', async () => {
    const results: Record<string, string> = {};
    for (const s of [...SCENARIOS, ...ESCALATED.map((e) => ({ ...e, action: `${e.action}(escalated)` }))]) {
      for (const [step, role] of s.stepRoles.entries()) {
        const multi = await h.operator(`nc4-multi-${s.action}-${step}`, [role, 'read_only_auditor']);
        const single = await h.operator(`nc4-single-${s.action}-${step}`, [role]);
        const c = await pending(h, s);
        for (let i = 0; i < step; i++) expect((await h.post(s.chain[i] as string, `${CR}/${c.id}/approvals`, { step_index: i })).status).toBe(201);
        await revokeRole(h.pg, multi, role);
        await revokeRole(h.pg, single, role);
        const a = await h.post(`nc4-multi-${s.action}-${step}`, `${CR}/${c.id}/approvals`, { step_index: step });
        const b = await h.post(`nc4-single-${s.action}-${step}`, `${CR}/${c.id}/approvals`, { step_index: step });
        results[`${s.action} step ${step}`] = `${out(a).join(' ')} / ${out(b).join(' ')}`;
        expect(out(a), `${s.action} step ${step} multi`).toEqual([409, 'COMMERCIAL_APPROVAL_REFUSED', 'STEP_SCOPE_MISSING']);
        expect([403, 409], `${s.action} step ${step} single ${out(b).join(' ')}`).toContain(b.status);
        expect(await approvalRows(h, c.id)).toHaveLength(step);
        // Control: a still-eligible human fills the step.
        expect((await h.post(s.chain[step] as string, `${CR}/${c.id}/approvals`, { step_index: step })).status, `${s.action} control`).toBe(201);
        await withdraw(s, c.id);
      }
    }
    console.log(`D4-NC4\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(11 + 3 * 2 + 2 * 2);
  });

  it('D4-NC5-ROLE approver eligibility lost between approval and apply, on every applyable type: the requester\'s apply is refused APPROVER_NO_LONGER_ELIGIBLE, fail closed (state APPROVED, no application row) and the signature is byte-identical; restoring the role lets the same request apply', async () => {
    const results: Record<string, string> = {};
    for (const s of APPLYABLE) {
      const approvers = s.stepRoles.map((role, i) => `nc5-${s.action}-${i}`);
      for (const [i, role] of s.stepRoles.entries()) await h.operator(approvers[i] as string, [role]);
      const c = await approved(h, s, approvers);
      const before = await approvalRows(h, c.id);
      const lost = s.stepRoles.length - 1; // the LAST signer loses the role
      await revokeRole(h.pg, h.user[approvers[lost] as string] as string, s.stepRoles[lost] as string);
      const res = await h.post(s.requester, applyPath(s, c.id));
      results[s.action] = out(res).join(' ');
      expect(out(res), s.action).toEqual([409, 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', 'APPROVER_NO_LONGER_ELIGIBLE']);
      expect(await requestState(h, c.id)).toBe('APPROVED');
      expect(await applications(c.id)).toBe(0);
      expect(await effectRows(c.id)).toBe(0);
      expect(await approvalRows(h, c.id)).toEqual(before);
      await grantRole(h.pg, h.user[approvers[lost] as string] as string, s.stepRoles[lost] as string);
      const ok = await h.post(s.requester, applyPath(s, c.id));
      expect(ok.status, `${s.action} after restore ${JSON.stringify(ok.body)}`).toBe(200);
      expect(await approvalRows(h, c.id)).toEqual(before);
    }
    console.log(`D4-NC5-ROLE\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(10);
  });

  it('D4-NC5-POLICY a policy version activated (through the governed POLICY_ACTIVATE HTTP flow) after requests were created does not re-threshold them: an in-flight escalated DISCOUNT keeps its Finance → Owner chain and snapshotted version; a new DISCOUNT of the same size is Finance-only under the new version; an in-flight SUBSCRIPTION_OPEN approves and applies under its snapshot', async () => {
    const before = (await h.pg.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id as string;
    const discount = ESCALATED.find((e) => e.action === 'DISCOUNT') as Scenario;
    const open = SCENARIOS.find((e) => e.action === 'SUBSCRIPTION_OPEN') as Scenario;
    const inflightDiscount = await pending(h, discount);
    const inflightOpen = await pending(h, open);
    // The governed activation: finance drafts (+3000 bps discount threshold), finance requests,
    // a distinct finance and an owner sign, the requester applies.
    const draftId = await policyDraft(h);
    expect((await h.call('finance_admin', 'PATCH', `/platform/commercial/policy-versions/${draftId}`, { content: { discount_escalation_threshold_bps: 3000 } })).status).toBe(200);
    const act = await h.post('finance_admin', CR, { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: draftId }, reason: 'D4 NC-5', idempotency_key: key('nc5p') });
    expect(act.status, JSON.stringify(act.body)).toBe(201);
    const actId = act.body.request.id as string;
    expect((await h.post('finance_admin', `${CR}/${actId}/submit`)).status).toBe(200);
    expect((await h.post('finance_admin_2', `${CR}/${actId}/approvals`, { step_index: 0 })).status).toBe(201);
    expect((await h.post('platform_owner', `${CR}/${actId}/approvals`, { step_index: 1 })).status).toBe(201);
    const applied = await h.post('finance_admin', `${CR}/${actId}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((await h.pg.query(`SELECT id FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id).toBe(draftId);

    const fresh = await discount.create(h);
    expect(fresh.res.status).toBe(201);
    const freshReq = fresh.res.body['request'] as { policy_version_id: string; required_chain: { rule: string } };
    expect(freshReq).toMatchObject({ policy_version_id: draftId, required_chain: { rule: 'FINANCE_ONLY' } });
    const inflight = (await h.get('finance_admin', `${CR}/${inflightDiscount.id}`)).body.request;
    expect(inflight).toMatchObject({ policy_version_id: before, required_chain: { rule: 'FINANCE_THEN_OWNER' } });
    expect((await h.post('finance_admin', `${CR}/${inflightDiscount.id}/approvals`, { step_index: 0 })).status).toBe(201);
    expect(await requestState(h, inflightDiscount.id)).toBe('PENDING_APPROVAL');
    expect((await h.post('platform_owner', `${CR}/${inflightDiscount.id}/approvals`, { step_index: 1 })).status).toBe(201);
    expect(await requestState(h, inflightDiscount.id)).toBe('APPROVED');

    expect((await h.post('finance_admin', `${CR}/${inflightOpen.id}/approvals`, { step_index: 0 })).status).toBe(201);
    const openApplied = await h.post('commercial_ops', `${CR}/${inflightOpen.id}/apply`);
    expect(openApplied.status, JSON.stringify(openApplied.body)).toBe(200);
    expect(openApplied.body.request).toMatchObject({ state: 'APPLIED', policy_version_id: before });
    console.log(`D4-NC5-POLICY before=${before} after=${draftId} inflight=${inflight.required_chain.rule} fresh=${freshReq.required_chain.rule}`);
  });

  it('D4-APPLY-1 requester-only apply on every applyable type: every other principal (each CCP role, a second holder of the requester role, every signer, super_admin) is refused 403 and writes nothing; apply_actionable is true for the requester only; the requester applies (200) and a replay is 200 replayed; role changes apply inside the final approval and CREDIT / DISCOUNT are not applyable (409)', async () => {
    const results: Record<string, Record<string, string>> = {};
    for (const s of APPLYABLE) {
      const c = await approved(h, s);
      const row: Record<string, string> = {};
      const others = [...new Set([...ALL_ROLES, `${s.requester}_2`, ...s.chain])].filter((who) => who !== s.requester);
      for (const who of others) {
        const res = await h.post(who, applyPath(s, c.id));
        row[who] = out(res).join(' ');
        expect(res.status, `${s.action} ${who} ${row[who]}`).toBe(403);
        const view = await h.get(who, `${CR}/${c.id}`);
        if (view.status === 200) expect(view.body.apply_actionable, `${s.action} ${who} apply_actionable`).toBe(false);
      }
      expect(await applications(c.id)).toBe(0);
      expect(await effectRows(c.id)).toBe(0);
      expect((await h.get(s.requester, `${CR}/${c.id}`)).body.apply_actionable, `${s.action} requester apply_actionable`).toBe(true);
      const ok = await h.post(s.requester, applyPath(s, c.id));
      row[s.requester] = String(ok.status);
      expect(ok.status, `${s.action} requester ${JSON.stringify(ok.body)}`).toBe(200);
      const again = await h.post(s.requester, applyPath(s, c.id));
      expect(again.status, s.action).toBe(200);
      expect(again.body.replayed, s.action).toBe(true);
      expect(await applications(c.id)).toBe(1);
      results[s.action] = row;
    }
    const nonApplyable: Record<string, string> = {};
    for (const s of SCENARIOS.filter((x) => x.apply === 'approval' || x.apply === null)) {
      const c = await approved(h, s);
      const res = await h.post(s.requester, `${CR}/${c.id}/apply`);
      nonApplyable[s.action] = `${await requestState(h, c.id)} apply → ${out(res).join(' ')}`;
      expect(res.status, s.action).toBeGreaterThanOrEqual(400);
      expect(await requestState(h, c.id), s.action).toBe(s.apply === 'approval' ? 'APPLIED' : 'APPROVED');
    }
    console.log(`D4-APPLY-1\n${JSON.stringify(results, null, 1)}\n${JSON.stringify(nonApplyable, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(10);
    expect(Object.keys(nonApplyable)).toHaveLength(4);
  });

  it('D4-TTL-1 APPLY_EXPIRED at the boundary on every applyable type (a policy version carrying apply_expiry_hours = 72, a raw test fixture): deadline − 1 ms the requester applies; exactly at the deadline the apply is refused APPLY_EXPIRED, the request becomes APPLY_EXPIRED and nothing is applied', async () => {
    // The B5 draft PATCH cannot set apply_expiry_hours (its DTO admits the eight format-1 keys only),
    // so the key is written into the one DRAFT raw, then activated raw (the A6-R fixture precedent).
    const vid = await policyDraft(h);
    const draftRow = (await h.pg.query(`SELECT content FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [vid])).rows[0];
    const content = { ...(draftRow.content as Record<string, unknown>), apply_expiry_hours: 72 };
    await h.pg.query(`UPDATE subscription."CommercialPolicyVersion" SET content = $2::jsonb, content_checksum = $3 WHERE id = $1`, [vid, JSON.stringify(content), commercialPolicyChecksum(content)]);
    await h.pg.query('BEGIN');
    try {
      await h.pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
      await h.pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [vid]);
      await h.pg.query('COMMIT');
    } catch (e) {
      await h.pg.query('ROLLBACK');
      throw e;
    }
    const A = new Date(Date.now() - 80 * H);
    const results: Record<string, string> = {};
    try {
      // POLICY_ACTIVATE last: its successful apply activates another version.
      for (const s of [...APPLYABLE.filter((x) => x.action !== 'POLICY_ACTIVATE'), ...APPLYABLE.filter((x) => x.action === 'POLICY_ACTIVATE')]) {
        clock.fixed = A;
        const late = await approved(h, s);
        clock.fixed = new Date(A.getTime() + 72 * H);
        const refused = await h.post(s.requester, applyPath(s, late.id));
        const lateState = await requestState(h, late.id);
        clock.fixed = A;
        const early = await approved(h, s);
        clock.fixed = new Date(A.getTime() + 72 * H - 1);
        const ok = await h.post(s.requester, applyPath(s, early.id));
        results[s.action] = `-1ms ${ok.status} / at ${out(refused).join(' ')} → ${lateState}`;
        expect(ok.status, `${s.action} deadline - 1ms ${JSON.stringify(ok.body)}`).toBe(200);
        expect(out(refused).slice(0, 1), `${s.action} at deadline ${JSON.stringify(refused.body)}`).toEqual([409]);
        expect(JSON.stringify(refused.body), s.action).toContain('APPLY_EXPIRED');
        expect(lateState, s.action).toBe('APPLY_EXPIRED');
        expect(await applications(late.id)).toBe(0);
        expect(await effectRows(late.id)).toBe(0);
      }
    } finally {
      clock.fixed = null;
    }
    console.log(`D4-TTL-1 policy=${vid}\n${JSON.stringify(results, null, 1)}`);
    expect(Object.keys(results)).toHaveLength(10);
  });

  it('D4-LAST-1 the last-owner invariant: with one effective platform_owner, the governed ROLE_REVOKE is refused (409 PLATFORM_LAST_OWNER) and the DB refuses role removal, membership deactivation and user deactivation; with two owners, revoking one needs the OTHER as checker, who is its subject (chain unfillable)', async () => {
    const owner = h.user['platform_owner'] as string;
    const membership = (await h.pg.query(`SELECT id FROM identity."UserTenantMembership" WHERE user_id = $1`, [owner])).rows[0].id as string;
    const raises = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await h.pg.query(sql, params);
        return 'ADMITTED';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const results: Record<string, string> = {};
    await suspended('platform_owner', [owner], async () => {
      const res = await h.post('platform_owner', CR, { action_type: 'ROLE_REVOKE', payload: { subject_user_id: owner, role_key: 'platform_owner' }, reason: 'D4 last owner', idempotency_key: key('last') });
      results['governed revoke'] = out(res).join(' ');
      expect(out(res)).toEqual([409, 'PLATFORM_LAST_OWNER', 'platform_last_owner']);
      const role = (await h.pg.query(`SELECT id FROM identity."Role" WHERE key = 'platform_owner'`)).rows[0].id as string;
      results['role removal'] = await raises(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1 AND role_id = $2`, [membership, role]);
      results['membership deactivation'] = await raises(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [membership]);
      results['user deactivation'] = await raises(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [owner]);
      for (const k of ['role removal', 'membership deactivation', 'user deactivation']) expect(results[k], k).toContain('platform_last_owner');
    });
    await suspended('platform_owner', [owner, h.user['platform_owner_2'] as string], async () => {
      const res = await h.post('platform_owner', CR, { action_type: 'ROLE_REVOKE', payload: { subject_user_id: h.user['platform_owner_2'], role_key: 'platform_owner' }, reason: 'D4 two owners', idempotency_key: key('last') });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await h.post('platform_owner', `${CR}/${res.body.request.id}/submit`)).status).toBe(200);
      const self = await h.post('platform_owner_2', `${CR}/${res.body.request.id}/approvals`, { step_index: 0 });
      results['two owners, subject signs'] = out(self).join(' ');
      expect(self.status).toBe(409);
      expect(await holders('platform_owner')).toHaveLength(2);
      await h.post('platform_owner', `${CR}/${res.body.request.id}/withdraw`);
    });
    console.log(`D4-LAST-1\n${JSON.stringify(results, null, 1)}`);
  });

  it('D4-SUPER-1 super_admin has no commercial authority: its live role scopes hold no commercial scope; it cannot be granted through a role change (400); it is never an eligible signer and never an applier (D4-GATE-1 refuses it on every route)', async () => {
    const scopes = (
      await h.pg.query(
        `SELECT s.key FROM identity."RoleScope" rs JOIN identity."Role" r ON r.id = rs.role_id JOIN identity."Scope" s ON s.id = rs.scope_id WHERE r.key = 'super_admin' ORDER BY s.key`,
      )
    ).rows.map((r) => r.key as string);
    const commercial = scopes.filter((k) => /^platform:(catalog|subscription|entitlement|billing|approval|commercial):/.test(k));
    expect(scopes).toHaveLength(10);
    expect(commercial).toEqual([]);
    const subject = await h.operator('super-subject', []);
    expect(out(await h.post('platform_owner', CR, { action_type: 'ROLE_GRANT', payload: { subject_user_id: subject, role_key: 'super_admin' }, reason: 'D4', idempotency_key: key('super') }))).toEqual([400, 'VALIDATION_ERROR', 'invalid_payload']);
    const s = SCENARIOS.find((x) => x.action === 'SUBSCRIPTION_OPEN') as Scenario;
    const c = await pending(h, s);
    expect(out(await h.post('super_admin', `${CR}/${c.id}/approvals`, { step_index: 0 }))[0]).toBe(403);
    console.log(`D4-SUPER-1 super_admin scopes=${scopes.join(',')}`);
  });
});
