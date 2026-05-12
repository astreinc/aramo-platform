// Opaque keyset cursor for IdentityAuditEvent pagination.
//
// Third instance of the cursor pattern at the module-level source-file tier
// (PR-6 introduced libs/consent/src/lib/util/history-cursor.ts; PR-7 reused it
// for the decision-log endpoint; PR-8.0a-prereq establishes a second module's
// instance under libs/identity/).
//
// Internal encoding is the tuple (created_at, event_id) base64url-encoded.
// Encoding includes BOTH so ordering stability is preserved across
// identical created_at values — matches the (created_at DESC, id DESC)
// composite key on IdentityAuditEvent's two @@index declarations.

export interface IdentityAuditCursorPayload {
  created_at: Date;
  event_id: string;
}

// Typed error for cursor decode failures. The (future) controller catches
// this and maps to HTTP 400 VALIDATION_ERROR; cursor errors must not
// propagate as 500. This PR has no controllers; the typed error is in
// place for downstream PR-8.0a/0b consumers.
export class CursorDecodeError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'CursorDecodeError';
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(payload: IdentityAuditCursorPayload): string {
  const created = payload.created_at.toISOString();
  const json = JSON.stringify({ c: created, e: payload.event_id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): IdentityAuditCursorPayload {
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
