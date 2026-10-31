import { describe, expect, it } from 'vitest';

import { computeEventHash, jsonbCanonical, verifyEventChain, type ChainEventRow } from '../lib/hash-chain.js';

// Retention and Purge directive (ebd41d99) LD-2 — payload keys hashed in jsonb order, and the
// chain verifier's explicit statuses.

const core = (payload: unknown, envelope_id = 'e1') => ({ envelope_id, event_type: 'X', actor_type: 'SYSTEM', actor_ref: null, payload, occurred_at: '2026-10-31T00:00:00.000Z' });

function chain(payloads: unknown[]): ChainEventRow[] {
  const rows: ChainEventRow[] = [];
  let prev: string | null = null;
  payloads.forEach((p, i) => {
    const c = core(p);
    const event_hash = computeEventHash(prev, c);
    rows.push({ id: `ev${i}`, ...c, previous_event_hash: prev, event_hash });
    prev = event_hash;
  });
  return rows;
}

describe('jsonb key order', () => {
  it('orders keys shorter-first then bytewise, recursively, dropping undefined', () => {
    expect(Object.keys(jsonbCanonical({ title: 1, envelope_document_id: 2, id: 3, ab: 4, aa: 5 }) as object)).toEqual(['aa', 'ab', 'id', 'title', 'envelope_document_id']);
    expect(jsonbCanonical({ b: { zz: 1, a: 2 }, a: [{ yy: 1, x: 2 }], u: undefined })).toEqual({ a: [{ x: 2, yy: 1 }], b: { a: 2, zz: 1 } });
    expect(JSON.stringify(jsonbCanonical({ b: { zz: 1, a: 2 } }))).toBe('{"b":{"a":2,"zz":1}}');
  });

  it('hashes independent of the writer key order (what jsonb returns recomputes)', () => {
    expect(computeEventHash(null, core({ title: 't', envelope_document_id: 'd' }))).toBe(computeEventHash(null, core({ envelope_document_id: 'd', title: 't' })));
  });

  it('a single-key or already-ordered payload hashes as before the change', () => {
    // Pre-change formula: JSON.stringify of the payload in its own key order.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const legacy = (payload: unknown) =>
      createHash('sha256').update(JSON.stringify({ previous: null, envelope_id: 'e1', event_type: 'X', actor_type: 'SYSTEM', actor_ref: null, payload, occurred_at: '2026-10-31T00:00:00.000Z' })).digest('base64url');
    expect(computeEventHash(null, core({ name: 'n' }))).toBe(legacy({ name: 'n' }));
    expect(computeEventHash(null, core({ id: 1, title: 't' }))).toBe(legacy({ id: 1, title: 't' }));
    expect(computeEventHash(null, core(null))).toBe(legacy(null));
  });
});

describe('verifyEventChain', () => {
  it('VERIFIED for an intact chain', () => {
    const v = verifyEventChain(chain([{ a: 1 }, { title: 't', id: 2 }, null]), []);
    expect(v).toMatchObject({ ok: true, verified: 3, link_only: 0, broken: [] });
  });

  it('a link break is BROKEN', () => {
    const rows = chain([{ a: 1 }, { b: 2 }]);
    rows[1] = { ...rows[1]!, previous_event_hash: 'other' };
    const v = verifyEventChain(rows, []);
    expect(v.ok).toBe(false);
    expect(v.broken).toContainEqual({ event_id: 'ev1', reason: 'link' });
  });

  it('a changed payload without a redaction record is LINK_ONLY, never VERIFIED', () => {
    const rows = chain([{ a: 1 }, { name: 'x' }]);
    rows[1] = { ...rows[1]!, payload: { name: 'y' } };
    const v = verifyEventChain(rows, []);
    expect(v.verified).toBe(1);
    expect(v.statuses[1]).toEqual({ event_id: 'ev1', status: 'LINK_ONLY' });
  });

  it('a redacted event is REDACTED_ATTESTED only with a matching, pre-verified record', () => {
    const rows = chain([{ a: 1 }, { name: 'x' }]);
    const original = rows[1]!.event_hash;
    rows[1] = { ...rows[1]!, payload: { name: '[REDACTED]' } };
    expect(verifyEventChain(rows, [{ event_id: 'ev1', original_event_hash: original, verified_before_redaction: true }]).statuses[1]?.status).toBe('REDACTED_ATTESTED');
    expect(verifyEventChain(rows, [{ event_id: 'ev1', original_event_hash: original, verified_before_redaction: false }]).statuses[1]?.status).toBe('REDACTED_LINK_ONLY');
    const bad = verifyEventChain(rows, [{ event_id: 'ev1', original_event_hash: 'not-it', verified_before_redaction: true }]);
    expect(bad.ok).toBe(false);
    expect(bad.broken).toContainEqual({ event_id: 'ev1', reason: 'redaction_record' });
  });
});
