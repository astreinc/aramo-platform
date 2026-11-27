// LIST-SELF-SIGN-1 (LOCKED 2026-11-27) — how "Sign" on a sent-envelope list row starts signing,
// ONE rule for Sign web and the Aramo Sign app. A self-sign session comes first whenever the
// server reports can_self_sign_now: an envelope from "Sign a document" has no live emailed link,
// so the inbox path is refused there (session_revoked, "This link was replaced or has expired").
// Otherwise the server's own inbox item for the user (my_inbox_item_id; the server sets it and
// awaiting_you together). Otherwise nothing to sign from the row.
//
// Pure TypeScript ESM, no dependency (type:client-shared).
import { SIGNABLE_ENVELOPE_STATUSES } from './envelope-lifecycle.js';

export type ListSignRoute = 'self' | 'inbox' | null;

export interface ListSignRow {
  readonly status: string;
  readonly can_self_sign_now?: boolean | null;
  readonly my_inbox_item_id?: string | null;
}

export function listSignRoute(row: ListSignRow): ListSignRoute {
  if (!SIGNABLE_ENVELOPE_STATUSES.includes(row.status)) return null;
  if (row.can_self_sign_now === true) return 'self';
  if (typeof row.my_inbox_item_id === 'string' && row.my_inbox_item_id !== '') return 'inbox';
  return null;
}
