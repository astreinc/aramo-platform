import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@aramo/fe-foundation';
import { listDocumentTemplates } from '@aramo/document-templates-web';

// ORG-UX-1 (handoff §5; directive §8.1) — the two counts App Home's Shortcuts card
// shows to organization admins. Read from the EXISTING endpoints only; while a read is
// loading or failed the subline is omitted (never an invented number).
//   Users & invitations  "{a} active · {i} invited"  GET /v1/tenant/users
//   Our templates        "{n} active"                GET /v1/document-templates
// The displayed-status precedence mirrors org-admin-web's user-status.ts: a disabled
// membership (is_active=false) is never active or invited; INVITED and ACCEPTED both
// display in the Invited tone, so both count as invited.

interface RosterRow {
  readonly is_active: boolean;
  readonly invite_status: string;
}

export interface UserCounts {
  readonly active: number;
  readonly invited: number;
}

export function countUsers(rows: readonly RosterRow[]): UserCounts {
  let active = 0;
  let invited = 0;
  for (const r of rows) {
    if (r.is_active === false) continue;
    if (r.invite_status === 'INVITED' || r.invite_status === 'ACCEPTED') invited += 1;
    else if (r.invite_status !== 'FAILED') active += 1;
  }
  return { active, invited };
}

async function fetchUserCounts(): Promise<UserCounts> {
  const res = await apiClient.get<{ items?: readonly RosterRow[] }>('/v1/tenant/users');
  return countUsers(Array.isArray(res?.items) ? res.items : []);
}

async function fetchActiveTemplateCount(): Promise<number> {
  const rows = await listDocumentTemplates();
  return (Array.isArray(rows) ? rows : []).filter((t) => t.status === 'ACTIVE').length;
}

function useRead<T>(enabled: boolean, read: () => Promise<T>): { readonly value: T | null; readonly reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    read()
      .then((v) => {
        if (!cancelled) setValue(v);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, read, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { value, reload };
}

/** Organization admins only (`enabled`): the Shortcuts counts. */
export function useOrgShortcutCounts(enabled: boolean): {
  readonly users: UserCounts | null;
  readonly activeTemplates: number | null;
  readonly reloadUsers: () => void;
} {
  const users = useRead(enabled, fetchUserCounts);
  const templates = useRead(enabled, fetchActiveTemplateCount);
  return { users: users.value, activeTemplates: templates.value, reloadUsers: users.reload };
}
