import { describe, expect, it } from 'vitest';

import { classifyPair, type AnchorForMatch } from '../lib/match-classification.js';
import type { SourceClass } from '../lib/vocab.js';

// TR-2a-2 — pure classifier unit tests (no DB, deterministic). Proves the band
// rule (R4), contradiction detection (R5), the no-share → null (not a match),
// PII-free output (refs only), and determinism (same input → same output).
// TR-2a-B2 adds source_class (default non-confirming so band assertions hold).

const a = (
  anchor_id: string,
  anchor_kind: 'EMAIL' | 'PHONE',
  normalized_value: string,
  source_class: SourceClass = 'THIRD_PARTY_UNVERIFIED',
): AnchorForMatch => ({
  anchor_id,
  anchor_kind,
  normalized_value,
  source_class,
});

describe('classifyPair — TR-2a-2 same-human classification', () => {
  it('one shared anchor → ADVISE_WEAK, no contradiction, points to both anchor rows', () => {
    const res = classifyPair(
      [a('a-email', 'EMAIL', 'ada@example.com')],
      [b('b-email', 'EMAIL', 'ada@example.com')],
    );
    expect(res).not.toBeNull();
    expect(res!.advise_band).toBe('ADVISE_WEAK');
    expect(res!.has_contradiction).toBe(false);
    expect(res!.shared).toEqual([
      { anchor_kind: 'EMAIL', a_anchor_id: 'a-email', b_anchor_id: 'b-email' },
    ]);
    // PII-free: no normalized_value on the shared refs.
    expect(JSON.stringify(res!.shared)).not.toContain('ada@example.com');
  });

  it('multi-kind shared (email + phone) → ADVISE_STRONG', () => {
    const res = classifyPair(
      [a('a-e', 'EMAIL', 'x@example.com'), a('a-p', 'PHONE', '15551234567')],
      [b('b-e', 'EMAIL', 'x@example.com'), b('b-p', 'PHONE', '15551234567')],
    );
    expect(res!.advise_band).toBe('ADVISE_STRONG');
    expect(res!.has_contradiction).toBe(false);
    expect(res!.shared).toHaveLength(2);
  });

  it('multiple same-kind shared (two emails) → ADVISE_STRONG', () => {
    const res = classifyPair(
      [a('a1', 'EMAIL', 'one@example.com'), a('a2', 'EMAIL', 'two@example.com')],
      [b('b1', 'EMAIL', 'one@example.com'), b('b2', 'EMAIL', 'two@example.com')],
    );
    expect(res!.advise_band).toBe('ADVISE_STRONG');
  });

  it('contradiction (same email, different phone) → flagged, WEAK (one shared)', () => {
    const res = classifyPair(
      [a('a-e', 'EMAIL', 'same@example.com'), a('a-p', 'PHONE', '11111111111')],
      [b('b-e', 'EMAIL', 'same@example.com'), b('b-p', 'PHONE', '22222222222')],
    );
    expect(res).not.toBeNull();
    expect(res!.advise_band).toBe('ADVISE_WEAK');
    expect(res!.has_contradiction).toBe(true);
    expect(res!.contradiction_kinds).toEqual(['PHONE']);
    // The shared set is the email only.
    expect(res!.shared).toEqual([
      { anchor_kind: 'EMAIL', a_anchor_id: 'a-e', b_anchor_id: 'b-e' },
    ]);
  });

  it('no shared anchor → null (not a match)', () => {
    expect(
      classifyPair(
        [a('a-e', 'EMAIL', 'alice@example.com')],
        [b('b-e', 'EMAIL', 'bob@example.com')],
      ),
    ).toBeNull();
  });

  it('a kind only one subject carries is neither shared nor a contradiction', () => {
    // Shared email; only A has a phone → phone is not comparable, no contradiction.
    const res = classifyPair(
      [a('a-e', 'EMAIL', 'same@example.com'), a('a-p', 'PHONE', '15551234567')],
      [b('b-e', 'EMAIL', 'same@example.com')],
    );
    expect(res!.has_contradiction).toBe(false);
    expect(res!.contradiction_kinds).toEqual([]);
    expect(res!.advise_band).toBe('ADVISE_WEAK');
  });

  it('is deterministic — identical input yields identical output', () => {
    const build = () =>
      classifyPair(
        [a('a-e', 'EMAIL', 'x@example.com'), a('a-p', 'PHONE', '15551234567')],
        [b('b-e', 'EMAIL', 'x@example.com'), b('b-p', 'PHONE', '15551234567')],
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  // TR-2a-B2 (DDR-2 §4) — confirming-BOTH shared refs.
  it('confirming-both on a shared value → confirmed_kinds lists the kind AND forces ADVISE_STRONG (even one shared)', () => {
    const res = classifyPair(
      [a('a-e', 'EMAIL', 'shared@example.com', 'THIRD_PARTY_VERIFIED')],
      [b('b-e', 'EMAIL', 'shared@example.com', 'THIRD_PARTY_VERIFIED')],
    );
    expect(res!.confirmed_kinds).toEqual(['EMAIL']);
    expect(res!.advise_band).toBe('ADVISE_STRONG'); // forced, despite one shared ref
  });

  it('confirming on only ONE side does NOT confirm the kind (band stays WEAK for one shared)', () => {
    const res = classifyPair(
      [a('a-e', 'EMAIL', 'shared@example.com', 'THIRD_PARTY_VERIFIED')],
      [b('b-e', 'EMAIL', 'shared@example.com', 'THIRD_PARTY_UNVERIFIED')],
    );
    expect(res!.confirmed_kinds).toEqual([]);
    expect(res!.advise_band).toBe('ADVISE_WEAK');
  });
});

function b(
  anchor_id: string,
  anchor_kind: 'EMAIL' | 'PHONE',
  normalized_value: string,
  source_class: SourceClass = 'THIRD_PARTY_UNVERIFIED',
): AnchorForMatch {
  return { anchor_id, anchor_kind, normalized_value, source_class };
}
