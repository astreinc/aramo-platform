// Client Rule Consolidation C1 / C3 (audit rows 1–13) — the server decides what a user may
// do with an envelope or an inbox item (directive G-2) and sends it as `actions`. Clients
// render those booleans and never derive them from status, scopes or ownership. This file
// holds only the key lists (one copy for the server and both clients) and the defensive
// read: a missing `actions` object, or a missing / non-boolean key, means "not allowed".

export const SENDER_ACTION_KEYS = [
  'edit',
  'send',
  'delete_draft',
  'void',
  'remind',
  'delete',
  'restore',
  'download',
  'certificate',
  'sign',
  'host_in_person',
  'purge',
  'dequeue_purge',
] as const;
export type SenderActionKey = (typeof SENDER_ACTION_KEYS)[number];
export type SenderActions = Readonly<Record<SenderActionKey, boolean>>;

export const INBOX_ACTION_KEYS = ['sign', 'download', 'delete', 'restore', 'report'] as const;
export type InboxActionKey = (typeof INBOX_ACTION_KEYS)[number];
export type InboxActions = Readonly<Record<InboxActionKey, boolean>>;

function read<K extends string>(keys: readonly K[], raw: unknown): Readonly<Record<K, boolean>> {
  const src = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<K, boolean>;
  for (const k of keys) out[k] = src[k] === true;
  return out;
}

/** The server's sender `actions` of a list row or detail; anything absent is false. */
export function senderActionsOf(row: { readonly actions?: unknown } | null | undefined): SenderActions {
  return read(SENDER_ACTION_KEYS, row?.actions);
}

/** The server's `actions` of a recipient inbox item; anything absent is false. */
export function inboxActionsOf(item: { readonly actions?: unknown } | null | undefined): InboxActions {
  return read(INBOX_ACTION_KEYS, item?.actions);
}

/** No action allowed (an envelope or item the server sent no decision for). */
export const NO_SENDER_ACTIONS: SenderActions = read(SENDER_ACTION_KEYS, null);
export const NO_INBOX_ACTIONS: InboxActions = read(INBOX_ACTION_KEYS, null);
