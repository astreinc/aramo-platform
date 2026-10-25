import { describe, expect, it } from 'vitest';

import { APPROVAL_REFUSALS } from './commercial-api';
import {
  REFUSAL_LABEL,
  chainMarks,
  chainName,
  chainSummary,
  effectRows,
  expiresCell,
  money,
  relativeShort,
  sortRows,
  stateSteps,
  summaryOf,
  tabRows,
  timelineOf,
  unfulfillableChains,
  verdictFor,
} from './commercial-model';
import { ME_ID, NOW, OTHER_ID, TWO_STEP_CHAIN, detail, request } from './test-fixtures';

// CCP-B1 — the inbox / drawer model (CCP-UI v1.0 handoff §3.1, §4, §5.1, §5.2).

const ctx = { meId: ME_ID, now: NOW };
const me = { id: ME_ID, name: 'Priya Shah' };

describe('verdictFor — the 7 eligibility reasons render inline (handoff §3.1, acceptance 3)', () => {
  it('pins the engine refusal set and its order', () => {
    expect(APPROVAL_REFUSALS).toEqual(['NOT_PENDING', 'EXPIRED', 'NOT_HUMAN', 'SELF_APPROVAL', 'USER_ALREADY_APPROVED', 'STEP_SCOPE_MISSING', 'OUT_OF_ORDER']);
    expect(Object.keys(REFUSAL_LABEL).sort()).toEqual([...APPROVAL_REFUSALS].sort());
  });

  it('OK: "You can sign the Finance step"', () => {
    const v = verdictFor(detail(request({ id: 'r1' })), ctx);
    expect(v).toMatchObject({ code: 'OK', label: 'You can sign the Finance step', stepIndex: 0 });
    expect(v.why).toBe('Approving records your name and current roles in the audit log.');
  });

  it('NOT_PENDING from the state, before the server verdict', () => {
    const v = verdictFor(detail(request({ id: 'r1', state: 'APPROVED', approved_at: '2026-10-24T11:00:00.000Z' }), { signed: 1 }), ctx);
    expect(v).toMatchObject({ code: 'NOT_PENDING', label: 'Not pending', why: 'This request is approved.' });
  });

  it('EXPIRED from is_expired', () => {
    const v = verdictFor(detail(request({ id: 'r1', expires_at: '2026-10-24T12:00:00.000Z' }), { expired: true }), ctx);
    expect(v).toMatchObject({ code: 'EXPIRED', label: 'Expired', why: 'The approval window closed 2 h ago.' });
  });

  it.each([
    ['NOT_HUMAN', 'Not a human actor', /attested people/],
    ['SELF_APPROVAL', 'You requested this', /^The person who made a request can’t approve it\.$/],
    ['STEP_SCOPE_MISSING', 'Missing the scope for this step', /^The Finance step needs the Finance admin role\.$/],
    ['OUT_OF_ORDER', 'Out of order', /^The Finance step must be signed first\.$/],
  ])('%s → "%s"', (refusal, label, why) => {
    const v = verdictFor(detail(request({ id: 'r1' }), { refusal }), ctx);
    expect(v.code).toBe(refusal);
    expect(v.label).toBe(label);
    expect(v.why).toMatch(why);
  });

  it('USER_ALREADY_APPROVED: the combined Finance + Owner person is refused the second step', () => {
    const r = request({ id: 'r2', required_chain: TWO_STEP_CHAIN });
    const v = verdictFor(detail(r, { signed: 1, refusal: 'USER_ALREADY_APPROVED', approver: ME_ID }), ctx);
    expect(v).toMatchObject({ code: 'USER_ALREADY_APPROVED', label: 'You already approved a step', stepIndex: 1 });
    expect(v.why).toBe('One person can sign only one step, even when they hold two roles.');
  });

  it('SELF_APPROVAL for the subject of a role change names the subject', () => {
    const r = request({ id: 'r3', action_type: 'ROLE_GRANT', tenant_id: null, product_key: null, payload: { subject_user_id: ME_ID, role_key: 'finance_admin' }, required_chain: { rule: 'DISTINCT_PLATFORM_OWNER', basis: {}, steps: [{ step_index: 0, role_key: 'platform_owner', scope_keys: [] }] } });
    expect(verdictFor(detail(r, { refusal: 'SELF_APPROVAL' }), ctx).why).toBe('A role change can’t be approved by the person it changes.');
  });
});

describe('chains (handoff §3)', () => {
  it('names each chain from the snapshotted rule and action', () => {
    expect(chainName(request({ id: 'a' }))).toBe('Below threshold');
    expect(chainName(request({ id: 'a', action_type: 'DISCOUNT', required_chain: TWO_STEP_CHAIN }))).toBe('Above threshold');
    expect(chainName(request({ id: 'a', action_type: 'PLAN_VERSION_PUBLISH', required_chain: TWO_STEP_CHAIN }))).toBe('Catalog publish');
    expect(chainName(request({ id: 'a', action_type: 'POLICY_ACTIVATE', required_chain: TWO_STEP_CHAIN }))).toBe('Policy change');
    expect(chainName(request({ id: 'a', action_type: 'ROLE_GRANT', required_chain: { rule: 'DISTINCT_PLATFORM_OWNER', basis: {}, steps: [] } }))).toBe('Role change (privileged)');
    expect(chainSummary(request({ id: 'a', required_chain: TWO_STEP_CHAIN }))).toBe('Above threshold: Finance → Owner');
  });

  it('chain progress: signed steps from the detail, else from the state', () => {
    const r = request({ id: 'a', required_chain: TWO_STEP_CHAIN });
    expect(chainMarks(r, detail(r, { signed: 1 }))).toEqual([
      { label: 'Finance', signed: true },
      { label: 'Owner', signed: false },
    ]);
    expect(chainMarks({ ...r, state: 'APPROVED' }, undefined).every((m) => m.signed)).toBe(true);
    expect(chainMarks(r, undefined).some((m) => m.signed)).toBe(false);
  });

  it('the bootstrap banner names each unfulfillable chain once', () => {
    const a = request({ id: 'a', required_chain: TWO_STEP_CHAIN, action_type: 'DISCOUNT', payload: { discount_bps: 3000 } });
    const b = request({ id: 'b', required_chain: TWO_STEP_CHAIN, action_type: 'DISCOUNT', payload: { discount_bps: 2500 } });
    const c = request({ id: 'c' });
    expect(unfulfillableChains([detail(a, { satisfiable: false }), detail(b, { satisfiable: false }), detail(c)])).toEqual(['Above threshold (Finance → Owner)']);
    expect(unfulfillableChains([], [c])).toEqual(['Below threshold (Finance)']);
  });
});

describe('TTL and time (handoff §4)', () => {
  it('pending: "n h left", amber under 12 h', () => {
    expect(expiresCell(request({ id: 'a' }), NOW)).toEqual({ text: '67 h left', tone: 'ink' });
    expect(expiresCell(request({ id: 'a', expires_at: '2026-10-24T22:00:00.000Z' }), NOW)).toEqual({ text: '8 h left', tone: 'warn' });
  });
  it('draft, expired, other states', () => {
    expect(expiresCell(request({ id: 'a', state: 'DRAFT', submitted_at: null, expires_at: null }), NOW).text).toBe('Not submitted');
    expect(expiresCell(request({ id: 'a', state: 'EXPIRED', expires_at: '2026-10-22T14:00:00.000Z' }), NOW)).toEqual({ text: 'Expired 2 d ago', tone: 'danger' });
    expect(expiresCell(request({ id: 'a', state: 'REJECTED' }), NOW).text).toBe('—');
  });
  it('relative time is hour-granular like the design', () => {
    expect(relativeShort('2026-10-24T13:30:00Z', NOW)).toBe('30 min ago');
    expect(relativeShort('2026-10-24T09:00:00Z', NOW)).toBe('5 h ago');
    expect(relativeShort('2026-10-20T14:00:00Z', NOW)).toBe('4 d ago');
  });
});

describe('the stepper (handoff §4 CrStepper)', () => {
  it('pending: Draft ✓, Pending approval ●, the rest ○', () => {
    expect(stateSteps('PENDING_APPROVAL').map((s) => s.mark)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
  });
  it('applied: every chip done', () => {
    expect(stateSteps('APPLIED').map((s) => s.mark)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
  // CCP-C4 — handoff §4: "While a Stripe-side request is Applying, that chip reads 'Sent to Stripe —
  // awaiting confirmation'" (Conversion Rule C-23).
  it('CCP-C4: a credit, discount or refund in Applying shows "Sent to Stripe — awaiting confirmation" on the current chip; other types and other states keep "Applying"', () => {
    for (const a of ['CREDIT', 'DISCOUNT', 'REFUND']) {
      const s = stateSteps('APPLYING', a);
      expect(s.map((x) => x.mark)).toEqual(['done', 'done', 'done', 'current', 'todo']);
      expect(s[3]?.label).toBe('Sent to Stripe — awaiting confirmation');
      expect(stateSteps('APPLIED', a)[3]?.label).toBe('Applying');
      expect(stateSteps('APPROVED', a)[3]?.label).toBe('Applying');
    }
    expect(stateSteps('APPLYING', 'SUBSCRIPTION_CHANGE')[3]?.label).toBe('Applying');
    expect(stateSteps('APPLYING')[3]?.label).toBe('Applying');
  });
  it('rejected: the reached chip ✕, later chips dimmed, a terminal chip appended', () => {
    const s = stateSteps('REJECTED');
    expect(s.map((x) => x.mark)).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'terminal']);
    expect(s.map((x) => x.dim)).toEqual([false, false, true, true, true, false]);
    expect(s[5]?.label).toBe('Rejected');
  });
});

describe('inbox tabs and sort (handoff §5.1)', () => {
  const p1 = request({ id: 'p1', expires_at: '2026-10-26T09:00:00.000Z' });
  const p2 = request({ id: 'p2', expires_at: '2026-10-25T09:00:00.000Z', requested_by: ME_ID });
  const d1 = request({ id: 'd1', state: 'DRAFT', submitted_at: null, expires_at: null, requested_by: ME_ID });
  const h1 = request({ id: 'h1', state: 'REJECTED', created_at: '2026-10-20T09:00:00.000Z' });
  const h2 = request({ id: 'h2', state: 'APPLIED', created_at: '2026-10-22T09:00:00.000Z' });
  const all = [p1, p2, d1, h1, h2];
  it('Waiting on me = pending ∩ the server eligible set', () => {
    expect(tabRows('me', all, new Set(['p1', 'd1', 'h1']), ME_ID).map((r) => r.id)).toEqual(['p1']);
  });
  it('All pending, Requested by me, History (no pending, no drafts)', () => {
    expect(tabRows('pending', all, new Set(), ME_ID).map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(tabRows('mine', all, new Set(), ME_ID).map((r) => r.id)).toEqual(['p2', 'd1']);
    expect(tabRows('history', all, new Set(), ME_ID).map((r) => r.id)).toEqual(['h1', 'h2']);
  });
  it('pending by soonest expiry, the rest newest first', () => {
    expect(sortRows([p1, p2]).map((r) => r.id)).toEqual(['p2', 'p1']);
    expect(sortRows([h1, h2]).map((r) => r.id)).toEqual(['h2', 'h1']);
  });
});

describe('summary and effect from the request payload', () => {
  it('credit / discount / extension / role change', () => {
    expect(summaryOf(request({ id: 'a' }), me)).toBe('$350 account credit');
    expect(summaryOf(request({ id: 'a', action_type: 'DISCOUNT', payload: { discount_bps: 3000 } }), me)).toBe('30% discount');
    expect(summaryOf(request({ id: 'a', action_type: 'SUPPORT_EXTENSION', payload: { requested_days: 14 } }), me)).toBe('+14 day support extension (escalated)');
    expect(summaryOf(request({ id: 'a', action_type: 'ROLE_GRANT', payload: { subject_user_id: OTHER_ID, role_key: 'finance_admin' } }), me)).toBe('Grant Finance admin to 0190000…');
  });
  it('money: USD design style, other currencies with the code', () => {
    expect(money(35000, 'USD')).toBe('$350');
    expect(money(35050, 'USD')).toBe('$350.5');
    expect(money(35000, 'EUR')).toBe('350.00 EUR');
  });
  it('the before side is null unless the request fixes it', () => {
    expect(effectRows(request({ id: 'a' }), me)).toEqual([{ field: 'Account credit', before: null, after: '$350' }]);
    expect(effectRows(request({ id: 'a', action_type: 'ROLE_REVOKE', payload: { subject_user_id: ME_ID, role_key: 'finance_admin' } }), me)).toEqual([
      { field: 'Priya Shah · Finance admin', before: 'Held', after: 'Not held' },
    ]);
  });
});

describe('timeline (handoff §5.2 item 10)', () => {
  it('submitted, steps signed and the terminal event, newest first', () => {
    const r = request({ id: 'a', required_chain: TWO_STEP_CHAIN, state: 'REJECTED', rejected_at: '2026-10-24T12:00:00.000Z', rejected_by: OTHER_ID, rejection_reason: 'No evidence.' });
    const ev = timelineOf(detail(r, { signed: 1 }), me);
    expect(ev.map((e) => e.label)).toEqual(['Rejected', 'Finance step signed', 'Submitted for approval']);
    expect(ev[0]?.note).toBe('No evidence.');
  });
});
