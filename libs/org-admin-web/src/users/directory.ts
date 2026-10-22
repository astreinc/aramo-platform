// ORG-UX-1 — the people + role-catalog read shared by Users & invitations, Roles & access
// and the Invite user modal. Two existing reads, nothing new:
//   GET /v1/tenant/users          (roster, incl. the ADD-only invited_at — G4)
//   GET /v1/tenant/roles-catalog  (role labels + descriptions + tiers)

import { useCallback, useEffect, useState } from 'react';

import { fetchRolesCatalog, type RoleCatalogView } from '../roles/roles-catalog-api';

import type { TenantUserView } from './types';
import { fetchTenantUsers } from './users-api';
import { OWNER_ROLE_KEY } from './role-groups';

export type DirectoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly users: readonly TenantUserView[]; readonly catalog: readonly RoleCatalogView[] };

export function useDirectory(): DirectoryState & { readonly reload: () => void } {
  const [state, setState] = useState<DirectoryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchTenantUsers(), fetchRolesCatalog()])
      .then(([list, catalog]) => {
        if (!cancelled) setState({ status: 'ready', users: list.items, catalog });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}

export function personName(u: Pick<TenantUserView, 'display_name' | 'email'>): string {
  const n = u.display_name?.trim();
  return n !== undefined && n.length > 0 ? n : u.email;
}

/** ROLES-1 — only a tenant_owner may grant or remove tenant_owner. */
export function isOwner(user: Pick<TenantUserView, 'role_keys'> | null | undefined): boolean {
  return user?.role_keys.includes(OWNER_ROLE_KEY) === true;
}
