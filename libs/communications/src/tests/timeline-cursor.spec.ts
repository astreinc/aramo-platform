import { describe, expect, it } from 'vitest';

import {
  CommunicationCursorDecodeError,
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '../lib/util/timeline-cursor.js';

// COMM-B7 — opaque keyset cursor for the Talent communication timeline. Encodes
// the (created_at, interaction_id) tuple so ordering is stable across identical
// created_at values — matches the (created_at DESC, id DESC) composite key. A
// bad cursor throws CommunicationCursorDecodeError (the controller maps it to
// 400 VALIDATION_ERROR; it must never surface as a 500).

const UUID = '01900000-0000-7000-8000-0000000000a1';

describe('timeline cursor', () => {
  it('round-trips a (created_at, interaction_id) payload', () => {
    const created_at = new Date('2026-08-26T12:00:00.000Z');
    const token = encodeTimelineCursor({ created_at, interaction_id: UUID });
    expect(typeof token).toBe('string');
    const back = decodeTimelineCursor(token);
    expect(back.interaction_id).toBe(UUID);
    expect(back.created_at.toISOString()).toBe('2026-08-26T12:00:00.000Z');
  });

  it('is opaque (base64url, not the raw ids)', () => {
    const token = encodeTimelineCursor({ created_at: new Date('2026-08-26T12:00:00.000Z'), interaction_id: UUID });
    expect(token).not.toContain(UUID);
    expect(token).not.toContain('2026-08-26');
  });

  it('rejects malformed cursors with a typed error', () => {
    expect(() => decodeTimelineCursor('')).toThrow(CommunicationCursorDecodeError);
    expect(() => decodeTimelineCursor('not-base64url!!')).toThrow(CommunicationCursorDecodeError);
    // valid base64url but wrong shape
    const bad = Buffer.from(JSON.stringify({ c: 'nope', e: 'not-a-uuid' }), 'utf8').toString('base64url');
    expect(() => decodeTimelineCursor(bad)).toThrow(CommunicationCursorDecodeError);
  });
});
