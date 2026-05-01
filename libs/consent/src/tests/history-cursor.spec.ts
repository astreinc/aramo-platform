import { describe, expect, it } from 'vitest';

import {
  CursorDecodeError,
  decodeCursor,
  encodeCursor,
  type HistoryCursorPayload,
} from '../lib/util/history-cursor.js';

// PR-6 §7 unit tests 1 + 2: cursor round-trip and malformed-input
// rejection. The cursor is the load-bearing primitive for the history
// endpoint's keyset pagination; correctness here is what makes the
// "strictly older" invariant under identical timestamps work
// (integration test 10).

describe('history-cursor — round-trip (PR-6 §7 test 1)', () => {
  it('decode(encode({ created_at, event_id })) === { created_at, event_id }', () => {
    const payload: HistoryCursorPayload = {
      created_at: new Date('2026-04-15T10:30:45.123Z'),
      event_id: 'd2d7a0f0-0000-7000-8000-000000000001',
    };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded.event_id).toBe(payload.event_id);
    expect(decoded.created_at.getTime()).toBe(payload.created_at.getTime());
  });

  it('encode(decode(encoded)) === encoded for representative inputs', () => {
    const inputs: HistoryCursorPayload[] = [
      // Standard UUID v7 + recent timestamp
      {
        created_at: new Date('2026-05-01T12:00:00.000Z'),
        event_id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
      },
      // UUID v4 (different version; cursor doesn't enforce v7)
      {
        created_at: new Date('2026-04-01T08:15:30.500Z'),
        event_id: 'aabbccdd-eeff-4011-9011-001122334455',
      },
      // Epoch boundary
      {
        created_at: new Date('1970-01-01T00:00:00.000Z'),
        event_id: '00000000-0000-7000-8000-000000000000',
      },
      // Far-future date (year 9999 boundary)
      {
        created_at: new Date('9999-12-31T23:59:59.999Z'),
        event_id: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
      },
    ];
    for (const payload of inputs) {
      const encoded = encodeCursor(payload);
      const reEncoded = encodeCursor(decodeCursor(encoded));
      expect(reEncoded).toBe(encoded);
    }
  });

  it('encode produces base64url (no +/= padding characters)', () => {
    const payload: HistoryCursorPayload = {
      created_at: new Date('2026-04-15T10:30:45.123Z'),
      event_id: 'd2d7a0f0-0000-7000-8000-000000000001',
    };
    const encoded = encodeCursor(payload);
    // base64url: only A-Z, a-z, 0-9, -, _ ; no + / =
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('history-cursor — rejects malformed input (PR-6 §7 test 2)', () => {
  it('rejects empty string', () => {
    expect(() => decodeCursor('')).toThrow(CursorDecodeError);
  });

  it('rejects non-base64url characters', () => {
    // Use characters outside base64url alphabet that also break JSON parsing
    expect(() => decodeCursor('!!!@@@###')).toThrow(CursorDecodeError);
  });

  it('rejects valid base64 that is not valid JSON', () => {
    const garbage = Buffer.from('not json at all', 'utf8').toString('base64url');
    expect(() => decodeCursor(garbage)).toThrow(CursorDecodeError);
  });

  it('rejects valid JSON that lacks required fields', () => {
    const partial = Buffer.from(JSON.stringify({ c: '2026-01-01T00:00:00Z' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(partial)).toThrow(CursorDecodeError);
  });

  it('rejects valid structure with non-string field types', () => {
    const wrongTypes = Buffer.from(JSON.stringify({ c: 12345, e: 67890 }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeCursor(wrongTypes)).toThrow(CursorDecodeError);
  });

  it('rejects valid structure with malformed event_id (not a UUID)', () => {
    const badUuid = Buffer.from(
      JSON.stringify({ c: '2026-01-01T00:00:00Z', e: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(badUuid)).toThrow(CursorDecodeError);
  });

  it('rejects valid structure with unparseable created_at', () => {
    const badDate = Buffer.from(
      JSON.stringify({ c: 'not a date', e: 'd2d7a0f0-0000-7000-8000-000000000001' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(badDate)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError specifically (typed for controller mapping)', () => {
    // The controller catches CursorDecodeError to map to HTTP 400
    // VALIDATION_ERROR. Any other error type would propagate as 500.
    try {
      decodeCursor('!!!');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CursorDecodeError);
      expect(err).toBeInstanceOf(Error);
      expect((err as CursorDecodeError).name).toBe('CursorDecodeError');
    }
  });
});
