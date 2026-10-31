// Retention and Purge directive (ebd41d99) — the `purge` field of sender envelope list items
// and detail: null until the envelope is queued for purge.

export interface PurgeView {
  state: string;
  level: string;
  due_at: string | null;
  executed_at: string | null;
}

export function purgeViewOf(e: {
  purge_state?: string | null;
  purge_level?: string | null;
  purge_due_at?: Date | null;
  purge_executed_at?: Date | null;
}): PurgeView | null {
  if (e.purge_state === null || e.purge_state === undefined || e.purge_level === null || e.purge_level === undefined) return null;
  return {
    state: e.purge_state,
    level: e.purge_level,
    due_at: e.purge_state === 'EXECUTED' || e.purge_due_at === null || e.purge_due_at === undefined ? null : e.purge_due_at.toISOString(),
    executed_at: e.purge_executed_at !== null && e.purge_executed_at !== undefined ? e.purge_executed_at.toISOString() : null,
  };
}
