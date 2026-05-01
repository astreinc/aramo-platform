// Opaque cursor for /consent/history pagination (PR-6 §5).
//
// Internal encoding is the tuple (created_at, event_id) base64-encoded.
// The cursor is opaque to consumers — its internal structure is not part
// of the API contract and may evolve without versioning.
//
// Encoding includes BOTH created_at AND event_id so that ordering stability
// is preserved across identical created_at values (per directive §5).
// Encoding only event_id is insufficient and a halt condition (§9).
//
// The cursor field exposed at the API/DTO surface is `event_id`; the DB
// column is `id`. The mapping is documented in the directive's §5; the
// only renaming permitted in PR-6.

export interface HistoryCursorPayload {
  created_at: Date;
  event_id: string;
}

// Typed error for cursor decode failures. The controller catches this
// and maps to HTTP 400 VALIDATION_ERROR per directive §3 + §5; cursor
// errors must not propagate as 500.
export class CursorDecodeError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'CursorDecodeError';
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(payload: HistoryCursorPayload): string {
  const created = payload.created_at.toISOString();
  const json = JSON.stringify({ c: created, e: payload.event_id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): HistoryCursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new CursorDecodeError('cursor must be a non-empty string');
  }
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CursorDecodeError('not valid base64url');
  }
  if (raw.length === 0) {
    throw new CursorDecodeError('decoded payload is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CursorDecodeError('decoded payload is not valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('c' in parsed) ||
    !('e' in parsed)
  ) {
    throw new CursorDecodeError('decoded payload missing required fields');
  }
  const obj = parsed as { c: unknown; e: unknown };
  if (typeof obj.c !== 'string' || typeof obj.e !== 'string') {
    throw new CursorDecodeError('decoded payload fields are not strings');
  }
  const createdAt = new Date(obj.c);
  if (Number.isNaN(createdAt.getTime())) {
    throw new CursorDecodeError('created_at is not a valid date');
  }
  if (!UUID_REGEX.test(obj.e)) {
    throw new CursorDecodeError('event_id is not a valid UUID');
  }
  return { created_at: createdAt, event_id: obj.e };
}
