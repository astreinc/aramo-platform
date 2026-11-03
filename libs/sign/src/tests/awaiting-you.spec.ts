import { describe, expect, it } from 'vitest';

import { awaitingYou } from '../lib/domain/recipients.js';

// Aramo Sign W2 §A3.5 — "Waiting for you": the only actionable steps are the sender's own,
// matched by bound_user_id or by the W2 discovery rule (proven current email, link kinds,
// sent at or after the proof).

const ME = '11111111-1111-7111-8111-111111111111';
const PROOF = { email: 'sam@example.test', proven_at: new Date('2026-10-01T00:00:00.000Z') };
const SENT = new Date('2026-10-10T00:00:00.000Z');
const env = (over: Record<string, unknown> = {}) => ({ status: 'SENT', routing_mode: 'PARALLEL', sent_at: SENT, expires_at: null, ...over });
let n = 0;
const r = (over: Record<string, unknown> = {}) => ({ id: `s${(n += 1)}`, status: 'PENDING', signing_order: n, recipient_kind: 'SIGNER', witness_for_signer_id: null, email: 'other@example.test', bound_user_id: null, ...over });

describe('awaitingYou', () => {
  it('row 1: a typed own email (normalized) with a proof', () => {
    expect(awaitingYou(env(), [r({ email: '  SAM@example.TEST ' })], ME, PROOF)).toBe(true);
  });
  it('row 2: assigned (bound_user_id) — with or without a proof', () => {
    expect(awaitingYou(env(), [r({ bound_user_id: ME })], ME, null)).toBe(true);
  });
  it('row 5: PARALLEL with another pending signer → false; after the other signs → true', () => {
    expect(awaitingYou(env(), [r({ email: 'sam@example.test' }), r()], ME, PROOF)).toBe(false);
    expect(awaitingYou(env(), [r({ email: 'sam@example.test' }), r({ status: 'SIGNED' })], ME, PROOF)).toBe(true);
  });
  it('row 6: I signed, others pending → false', () => {
    expect(awaitingYou(env({ status: 'IN_PROGRESS' }), [r({ email: 'sam@example.test', status: 'SIGNED' }), r()], ME, PROOF)).toBe(false);
  });
  it('SEQUENTIAL: only the current turn counts', () => {
    expect(awaitingYou(env({ routing_mode: 'SEQUENTIAL' }), [r({ signing_order: 1 }), r({ signing_order: 2, email: 'sam@example.test' })], ME, PROOF)).toBe(false);
    expect(awaitingYou(env({ routing_mode: 'SEQUENTIAL' }), [r({ signing_order: 1, status: 'SIGNED' }), r({ signing_order: 2, email: 'sam@example.test' })], ME, PROOF)).toBe(true);
  });
  it('a witness waiting for its signer is not actionable', () => {
    const principal = r({ email: 'sam@example.test' });
    const witness = r({ recipient_kind: 'WITNESS', witness_for_signer_id: principal.id });
    expect(awaitingYou(env(), [principal, witness], ME, PROOF)).toBe(true);
  });
  it('row 20 (C2): an envelope sent before the proof is not matched by email', () => {
    expect(awaitingYou(env({ sent_at: new Date('2026-09-30T23:59:59.000Z') }), [r({ email: 'sam@example.test' })], ME, PROOF)).toBe(false);
    expect(awaitingYou(env({ sent_at: PROOF.proven_at }), [r({ email: 'sam@example.test' })], ME, PROOF)).toBe(true);
  });
  it('an in-person signer or a copy recipient is never matched by email', () => {
    expect(awaitingYou(env(), [r({ email: 'sam@example.test', recipient_kind: 'IN_PERSON_SIGNER' })], ME, PROOF)).toBe(false);
    expect(awaitingYou(env(), [r({ email: 'sam@example.test', recipient_kind: 'RECEIVES_COPY' }), r()], ME, PROOF)).toBe(false);
  });
  it('closed, draft or expired envelopes → false', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']) expect(awaitingYou(env({ status }), [r({ bound_user_id: ME })], ME, PROOF)).toBe(false);
    expect(awaitingYou(env({ expires_at: new Date(Date.now() - 1) }), [r({ bound_user_id: ME })], ME, PROOF)).toBe(false);
  });
  it("another user's bound step is not mine", () => {
    expect(awaitingYou(env(), [r({ bound_user_id: '22222222-2222-7222-8222-222222222222' })], ME, PROOF)).toBe(false);
  });
});
