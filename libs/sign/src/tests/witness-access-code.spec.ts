import { describe, expect, it } from 'vitest';

import { computeEventHash, verifyEventChain, type ChainEventRow } from '../lib/hash-chain.js';
import { ACCESS_CODE_FAILED_EVENT, ACCESS_CODE_LOCKED_EVENT, ACCESS_CODE_VERIFIED_EVENT, hashAccessCode, normalizeAccessCode, verifyAccessCode } from '../lib/domain/access-code.js';
import {
  SIGNER_DELEGATED_EVENT,
  WITNESS_ATTESTED_EVENT,
  allSigningRecipientsSigned,
  invitedAtSend,
  isLinkSigner,
  isSigningRecipient,
  mayActNow,
  pendingWitnessesOf,
  recipientKindOf,
  witnessReady,
} from '../lib/domain/recipients.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.17 / §1.9 —
// the pure rules: the WITNESS kind in the shared recipient helpers, the access-code hash,
// and the new ledger event types chaining like any other event.

const row = (id: string, order: number, kind: string, status = 'PENDING', witness_for_signer_id: string | null = null) => ({
  id,
  signing_order: order,
  recipient_kind: kind,
  status,
  witness_for_signer_id,
});

describe('§1.17 WITNESS in the shared recipient rules', () => {
  it('a witness is a signing recipient, emailed a link, and blocks completion', () => {
    const w = row('w', 2, 'WITNESS', 'PENDING', 's');
    expect(recipientKindOf(w)).toBe('WITNESS');
    expect(isSigningRecipient(w)).toBe(true);
    expect(isLinkSigner(w)).toBe(true);
    expect(allSigningRecipientsSigned([row('s', 1, 'SIGNER', 'SIGNED'), w])).toBe(false);
    expect(allSigningRecipientsSigned([row('s', 1, 'SIGNER', 'SIGNED'), { ...w, status: 'SIGNED' }])).toBe(true);
  });

  it('a witness is ready only once the signer it witnesses has signed', () => {
    const rows = [row('s', 1, 'SIGNER'), row('w', 2, 'WITNESS', 'PENDING', 's')];
    expect(witnessReady(rows, rows[1]!)).toBe(false);
    expect(witnessReady(rows, rows[0]!)).toBe(true);
    const signed = [row('s', 1, 'SIGNER', 'SIGNED'), rows[1]!];
    expect(witnessReady(signed, rows[1]!)).toBe(true);
    // A witness pointing nowhere is never ready.
    expect(witnessReady(rows, row('x', 3, 'WITNESS', 'PENDING', 'missing'))).toBe(false);
  });

  it('PARALLEL send invites every SIGNER but no witness; SEQUENTIAL invites the first turn', () => {
    const rows = [row('a', 1, 'SIGNER'), row('b', 2, 'SIGNER'), row('w', 3, 'WITNESS', 'PENDING', 'a'), row('c', 4, 'RECEIVES_COPY')];
    expect(invitedAtSend('PARALLEL', rows).map((r) => r.id)).toEqual(['a', 'b']);
    expect(invitedAtSend('SEQUENTIAL', rows).map((r) => r.id)).toEqual(['a']);
  });

  it('mayActNow refuses a witness before its signer signed, in both routing modes', () => {
    const rows = [row('a', 1, 'SIGNER'), row('w', 2, 'WITNESS', 'PENDING', 'a')];
    expect(mayActNow('PARALLEL', rows, 'w')).toBe(false);
    expect(mayActNow('PARALLEL', rows, 'a')).toBe(true);
    const signed = [row('a', 1, 'SIGNER', 'SIGNED'), rows[1]!];
    expect(mayActNow('PARALLEL', signed, 'w')).toBe(true);
    expect(mayActNow('SEQUENTIAL', signed, 'w')).toBe(true);
  });

  it('pendingWitnessesOf lists the open witnesses of one signer', () => {
    const rows = [row('a', 1, 'SIGNER'), row('w1', 2, 'WITNESS', 'PENDING', 'a'), row('w2', 3, 'WITNESS', 'SIGNED', 'a'), row('w3', 4, 'WITNESS', 'VIEWED', 'b')];
    expect(pendingWitnessesOf(rows, 'a').map((r) => r.id)).toEqual(['w1']);
  });
});

describe('§1.9 access code hash', () => {
  it('normalizes: trimmed, 4 to 32 printable characters', () => {
    expect(normalizeAccessCode('  1234 ')).toBe('1234');
    expect(normalizeAccessCode('123')).toBeNull();
    expect(normalizeAccessCode('x'.repeat(33))).toBeNull();
    expect(normalizeAccessCode('12\n34')).toBeNull();
    expect(normalizeAccessCode(1234)).toBeNull();
  });

  it('stores a salted scrypt hash that never contains the code, and verifies only the right code', () => {
    const a = hashAccessCode('Blue-42');
    const b = hashAccessCode('Blue-42');
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(a).not.toContain('Blue-42');
    expect(a).not.toBe(b); // salted
    expect(verifyAccessCode('Blue-42', a)).toBe(true);
    expect(verifyAccessCode(' Blue-42 ', a)).toBe(true);
    expect(verifyAccessCode('blue-42', a)).toBe(false);
    expect(verifyAccessCode(undefined, a)).toBe(false);
    expect(verifyAccessCode('Blue-42', 'plain')).toBe(false);
    expect(verifyAccessCode('Blue-42', 'scrypt$1$8$1$AA$AA')).toBe(false);
  });
});

describe('the new ledger event types chain and verify like every other event', () => {
  it('a chain with WITNESS_ATTESTED, SIGNER_DELEGATED and the ACCESS_CODE_* events verifies; any tamper breaks it', () => {
    const envelope_id = '11111111-1111-1111-1111-111111111111';
    const specs: Array<[string, unknown]> = [
      ['ENVELOPE_SENT', null],
      [ACCESS_CODE_FAILED_EVENT, { session_id: 's1', failed_attempts: 1, verification_method: 'ACCESS_CODE' }],
      [ACCESS_CODE_VERIFIED_EVENT, { session_id: 's1', verification_method: 'ACCESS_CODE' }],
      [SIGNER_DELEGATED_EVENT, { from_email_sha256: 'a'.repeat(64), to_email_sha256: 'b'.repeat(64), revoked_session_id: 's1', reason: 'on leave' }],
      [ACCESS_CODE_LOCKED_EVENT, { session_id: 's2', failed_attempts: 5, verification_method: 'ACCESS_CODE' }],
      ['SIGNER_SIGNED', null],
      [WITNESS_ATTESTED_EVENT, { witness_for_signer_id: 'p' }],
    ];
    const events: ChainEventRow[] = [];
    let prev: string | null = null;
    for (const [i, [event_type, payload]] of specs.entries()) {
      const core = { envelope_id, event_type, actor_type: 'SIGNER', actor_ref: null, payload, occurred_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() };
      const event_hash = computeEventHash(prev, core);
      events.push({ ...core, id: `e${i}`, previous_event_hash: prev, event_hash });
      prev = event_hash;
    }
    const ok = verifyEventChain(events, []);
    expect(ok).toMatchObject({ ok: true, verified: specs.length, link_only: 0 });
    const tampered = events.map((e) => (e.event_type === WITNESS_ATTESTED_EVENT ? { ...e, payload: { witness_for_signer_id: 'other' } } : e));
    expect(verifyEventChain(tampered, []).link_only).toBe(1);
  });
});
