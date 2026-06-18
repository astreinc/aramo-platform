import { describe, expect, it } from 'vitest';

import { assertContactVocab } from '../lib/dto/contact-vocab.js';

// Contact-spec amendment v1.0 — closed-vocab @IsIn contract (app-layer).

const RID = 'rq-contact-vocab-001';

describe('assertContactVocab', () => {
  it('accepts every in-vocab relationship_role + preference value', () => {
    for (const r of [
      'decision_maker',
      'hiring_manager',
      'champion',
      'influencer',
      'gatekeeper',
      'billing_contact',
    ]) {
      expect(() =>
        assertContactVocab({ relationship_role: r }, RID),
      ).not.toThrow();
    }
    for (const p of ['contactable', 'limited', 'do_not_contact']) {
      expect(() => assertContactVocab({ preference: p }, RID)).not.toThrow();
    }
  });

  it('undefined (omit) and null (clear) are allowed — no fabricated value', () => {
    expect(() => assertContactVocab({}, RID)).not.toThrow();
    expect(() =>
      assertContactVocab({ relationship_role: null, preference: null }, RID),
    ).not.toThrow();
  });

  it('rejects an out-of-vocab relationship_role with 400 VALIDATION_ERROR + details.field', () => {
    expect(() =>
      assertContactVocab({ relationship_role: 'best_friend' }, RID),
    ).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      }),
    );
  });

  it('rejects an out-of-vocab preference', () => {
    expect(() =>
      assertContactVocab({ preference: 'maybe' }, RID),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
