// COMM-B7 — opaque keyset cursor for the Talent communication timeline. Mirrors
// the established module-level cursor pattern (consent history-cursor, identity
// audit-cursor): the tuple (created_at, interaction_id) is base64url-encoded so
// ordering stays stable across identical created_at values — matching the
// (created_at DESC, id DESC) composite ordering of the timeline read.

export interface TimelineCursorPayload {
  created_at: Date;
  interaction_id: string;
}

/** Cursor decode failure. The controller maps this to 400 VALIDATION_ERROR. */
export class CommunicationCursorDecodeError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'CommunicationCursorDecodeError';
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeTimelineCursor(payload: TimelineCursorPayload): string {
  const json = JSON.stringify({ c: payload.created_at.toISOString(), i: payload.interaction_id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeTimelineCursor(cursor: string): TimelineCursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new CommunicationCursorDecodeError('cursor must be a non-empty string');
  }
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CommunicationCursorDecodeError('not valid base64url');
  }
  // base64url is lenient — a bad token can decode to garbage; validate the shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommunicationCursorDecodeError('decoded payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || !('c' in parsed) || !('i' in parsed)) {
    throw new CommunicationCursorDecodeError('decoded payload missing required fields');
  }
  const obj = parsed as { c: unknown; i: unknown };
  if (typeof obj.c !== 'string' || typeof obj.i !== 'string') {
    throw new CommunicationCursorDecodeError('decoded payload fields are not strings');
  }
  const created_at = new Date(obj.c);
  if (Number.isNaN(created_at.getTime())) {
    throw new CommunicationCursorDecodeError('created_at is not a valid date');
  }
  if (!UUID_REGEX.test(obj.i)) {
    throw new CommunicationCursorDecodeError('interaction_id is not a valid UUID');
  }
  return { created_at, interaction_id: obj.i };
}
