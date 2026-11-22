// Client Rule Consolidation C3 (PO 2026-11-21, D-1) — runs under vitest and mobile Jest.
// The locked-check rules: the server's in-lock checks and the C1 actions call these functions.
import {
  PARTY_DELETABLE_STATUSES,
  PURGE_ELIGIBLE_STATUSES,
  envelopeOpenForSigning,
  hostedSessionRefusal,
  isDraftEditable,
  isPartyDeletable,
  isPurgeEligible,
  isPurgeExecuted,
  isPurgeQueued,
  remindableSigners,
  selfSignTarget,
  sessionIssueRefusal,
  signerMayStillSign,
  type TurnRow,
} from '../index.js';

const STATUSES = ['DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'];

describe('envelope state rules', () => {
  it.each(STATUSES)('%s', (s) => {
    expect(isDraftEditable(s)).toBe(s === 'DRAFT');
    expect(isPurgeEligible(s)).toBe(['COMPLETED', 'DECLINED', 'VOIDED'].includes(s));
    expect(isPartyDeletable(s)).toBe(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'].includes(s));
  });
  it('sets', () => {
    expect([...PURGE_ELIGIBLE_STATUSES]).toEqual(['COMPLETED', 'DECLINED', 'VOIDED']);
    expect([...PARTY_DELETABLE_STATUSES]).toEqual(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
  });
  it.each([
    ['EXECUTED', true, false],
    ['QUEUED', false, true],
    ['DEQUEUED', false, false],
    [null, false, false],
    [undefined, false, false],
  ] as const)('purge %s', (p, executed, queued) => {
    expect(isPurgeExecuted(p)).toBe(executed);
    expect(isPurgeQueued(p)).toBe(queued);
  });
});

describe('signing rules', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  const past = new Date('2026-11-20T00:00:00Z');
  const future = new Date('2026-11-22T00:00:00Z');
  it.each([
    [{ status: 'SENT' }, true],
    [{ status: 'IN_PROGRESS', expires_at: future }, true],
    [{ status: 'IN_PROGRESS', expires_at: past }, false],
    [{ status: 'SENT', deleted_at: past }, false],
    [{ status: 'DRAFT' }, false],
    [{ status: 'COMPLETED' }, false],
  ])('envelopeOpenForSigning %j → %s', (env, ok) => {
    expect(envelopeOpenForSigning(env, now)).toBe(ok);
  });
  it.each([['PENDING', true], ['VIEWED', true], ['SIGNED', false], ['DECLINED', false]])('signerMayStillSign %s', (s, ok) => {
    expect(signerMayStillSign(s)).toBe(ok);
  });

  const r = (id: string, o: Partial<TurnRow & { bound_user_id: string | null }> = {}) => ({ id, status: 'PENDING', signing_order: Number(id.slice(1)), recipient_kind: 'SIGNER', witness_for_signer_id: null, bound_user_id: null, ...o });
  const rows = [r('s1', { status: 'SIGNED' }), r('s2'), r('s3', { recipient_kind: 'IN_PERSON_SIGNER' }), r('s4', { recipient_kind: 'RECEIVES_COPY' }), r('s5', { recipient_kind: 'WITNESS', witness_for_signer_id: 's2' })];

  it.each([
    ['PARALLEL', 'SENT', ['s2']],
    ['SEQUENTIAL', 'SENT', ['s2']],
    ['PARALLEL', 'COMPLETED', []],
  ])('remindableSigners %s %s', (routing_mode, status, ids) => {
    expect(remindableSigners({ status, routing_mode }, rows).map((x) => x.id)).toEqual(ids);
  });
  it('a witness is reminded once its signer signed', () => {
    const signed = rows.map((x) => (x.id === 's2' ? { ...x, status: 'SIGNED' } : x));
    expect(remindableSigners({ status: 'IN_PROGRESS', routing_mode: 'PARALLEL' }, signed).map((x) => x.id)).toEqual(['s5']);
  });

  it.each([
    ['s2', 'PARALLEL', 'SENT', null, null],
    ['s9', 'PARALLEL', 'SENT', 'signer_not_found', 'signer_not_found'],
    ['s2', 'PARALLEL', 'COMPLETED', 'envelope_not_signable', 'envelope_not_signable'],
    ['s4', 'PARALLEL', 'SENT', 'signer_ineligible', 'signer_ineligible'],
    ['s1', 'PARALLEL', 'SENT', 'signer_ineligible', 'signer_ineligible'],
    ['s3', 'SEQUENTIAL', 'SENT', 'not_your_turn', 'not_your_turn'],
    ['s3', 'PARALLEL', 'SENT', null, null],
  ] as const)('session %s %s %s → shared %s / hosted', (id, routing_mode, status, shared, hostedBase) => {
    const env = { status, routing_mode, expires_at: null };
    expect(sessionIssueRefusal(env, rows, id, now)).toBe(shared);
    const kind = rows.find((x) => x.id === id)?.recipient_kind;
    expect(hostedSessionRefusal(env, rows, id, now)).toBe(hostedBase ?? (kind === 'IN_PERSON_SIGNER' ? null : 'not_in_person_signer'));
  });

  it.each([
    ['u', undefined, 's2'],
    ['u', 's6', 's6'],
    ['x', undefined, null],
  ] as const)('selfSignTarget(%s, %s) → %s', (user, signer, want) => {
    const bound = [r('s4', { recipient_kind: 'RECEIVES_COPY', bound_user_id: 'u' }), r('s6', { bound_user_id: 'u' }), r('s2', { bound_user_id: 'u' })];
    expect(selfSignTarget(bound, user, signer)?.id ?? null).toBe(want);
  });
});
