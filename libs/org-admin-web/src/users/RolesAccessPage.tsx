import { useMemo, useState } from 'react';
import { productByKey, ssoEntryHref, useToast, type ProductAvailabilityView, type Session } from '@aramo/fe-foundation';

import type { RoleCatalogView } from '../roles/roles-catalog-api';
import { OrgAvatar, OrgPageHeader } from '../ui/OrgPage';

import { isOwner, personName, useDirectory } from './directory';
import { RemoveSignAccess } from './RemoveSignAccess';
import {
  buildRoleGroups,
  KEEP_ONE_ROLE_HINT,
  LAST_OWNER_BLOCK,
  OWNER_ONLY_HINT,
  OWNER_ROLE_KEY,
  roleWriteErrorMessage,
  subscribedApps,
  type RoleGroupKey,
} from './role-groups';
import type { TenantUserView } from './types';
import { deriveDisplayedStatus } from './user-status';
import { assignTenantUserRoles } from './users-api';

import './org-people.css';

// ORG-UX-1 (handoff §6.4 "Roles & access", route /org/roles; Directive v1.0 LOCKED §8.4,
// §13.2) — the per-role view: every role from the catalog, grouped by app, and who holds
// it. "Manage people" opens the row to add / remove holders; each change is the existing
// whole-set PATCH /v1/tenant/users/:id/roles (current roles ± this role), audited by the
// server. Disabled people are excluded. No create / rename / custom roles.
// M-A8 §2.3 — "Remove Sign access" (RemoveSignAccess) removes only a member's Aramo Sign
// roles and signs them out of Aramo Sign (DELETE /v1/tenant/users/:id/products/sign).

type Filter = 'all' | RoleGroupKey;

const COLS = 'minmax(240px,1.6fr) 120px minmax(170px,1fr) 120px 150px';
const NO_USERS: readonly TenantUserView[] = [];
const NO_ROLES: readonly RoleCatalogView[] = [];

const ICON: Readonly<Record<RoleGroupKey, string>> = {
  org: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM9 12l2 2 4-4.5',
  ats: 'M3 9h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  sign: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
};

/** ATS Settings › ATS roles & permissions (read-only role page). */
export const ATS_ROLES_HREF = '/ats/admin/settings/roles';

/** Sign Settings › Users & roles, through Sign's sign-in route (it may be on its own host). */
export function signRolesHref(products: ProductAvailabilityView | null | undefined): string | null {
  const sign = productByKey(products ?? null, 'sign');
  if (sign === null || !sign.available || sign.entry_path === null) return null;
  const entry = sign.entry_path;
  if (/^https?:\/\//i.test(entry)) return ssoEntryHref(`${new URL(entry).origin}/sign/settings/members`, 'sign');
  if (entry.startsWith('/') && !entry.startsWith('//')) return ssoEntryHref('/sign/settings/members', 'sign');
  return null;
}

export function RolesAccessPage({ session, products }: { readonly session?: Session; readonly products?: ProductAvailabilityView | null }) {
  const toast = useToast();
  const dir = useDirectory();
  const subs = useMemo(() => subscribedApps(products), [products]);
  const me = session?.sub ?? null;
  const [filter, setFilter] = useState<Filter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [addPick, setAddPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const users = dir.status === 'ready' ? dir.users : NO_USERS;
  const catalog = dir.status === 'ready' ? dir.catalog : NO_ROLES;
  const groups = useMemo(() => buildRoleGroups(catalog, subs), [catalog, subs]);
  const live = useMemo(() => users.filter((u) => deriveDisplayedStatus(u) !== 'INACTIVE'), [users]);
  const callerIsOwner = isOwner(users.find((u) => u.user_id === me));
  const signHref = signRolesHref(products);

  const segs: readonly { key: Filter; label: string }[] = [
    { key: 'all', label: 'All apps' },
    { key: 'org', label: 'Organization' },
    ...(subs.ats ? [{ key: 'ats' as const, label: 'Aramo ATS' }] : []),
    ...(subs.sign ? [{ key: 'sign' as const, label: 'Aramo Sign' }] : []),
  ];

  const toggleRow = (key: string, others: readonly TenantUserView[]) => {
    setRowError(null);
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    setAddPick(others[0]?.user_id ?? '');
  };

  const write = async (u: TenantUserView, next: readonly string[], ok: string) => {
    setBusy(true);
    setRowError(null);
    try {
      await assignTenantUserRoles({ userId: u.user_id, body: { role_keys: next } });
      toast.show(ok);
      dir.reload();
    } catch (err: unknown) {
      setRowError(roleWriteErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (role: RoleCatalogView, holders: readonly TenantUserView[], u: TenantUserView) => {
    if (role.key === OWNER_ROLE_KEY && holders.length <= 1) {
      setRowError(LAST_OWNER_BLOCK);
      return;
    }
    if (u.role_keys.length <= 1) {
      setRowError(`${personName(u)} needs at least one role. ${KEEP_ONE_ROLE_HINT}`);
      return;
    }
    void write(
      u,
      u.role_keys.filter((k) => k !== role.key),
      `${personName(u)} no longer has ${role.display}.`,
    );
  };

  const add = (role: RoleCatalogView, others: readonly TenantUserView[]) => {
    const u = others.find((x) => x.user_id === addPick) ?? others[0];
    if (u === undefined) return;
    const rest = others.filter((x) => x.user_id !== u.user_id);
    setAddPick(rest[0]?.user_id ?? '');
    void write(u, [...u.role_keys, role.key], `${personName(u)} now has ${role.display}.`);
  };

  const shownGroups = groups.filter((g) => filter === 'all' || g.key === filter);

  return (
    <div data-testid="org-roles-page">
      <OrgPageHeader section="roles" />
      <div className="oxp-stack">
        <div className="oxp-rolesbar">
          <span className="ox-seg" role="group" aria-label="App">
            {segs.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={filter === s.key}
                data-testid={`seg-${s.key}`}
                onClick={() => {
                  setFilter(s.key);
                  setOpenKey(null);
                }}
              >
                {s.label}
              </button>
            ))}
          </span>
          <span className="oxp-rolesbar__note">{"Each app shows these roles read-only. An app admin role doesn't make someone an organization admin."}</span>
        </div>

        {dir.status === 'error' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            We couldn’t load roles.{' '}
            <button type="button" className="ox-link" onClick={dir.reload}>
              Try again
            </button>
          </div>
        ) : null}

        <div className="ox-card oxp-table">
          <div role="table" aria-label="Roles" aria-busy={dir.status === 'loading'} className="oxp-roles-min">
            <div className="ox-tr ox-tr--head oxp-roles-row" role="row" style={{ gridTemplateColumns: COLS }}>
              <span role="columnheader">Role</span>
              <span role="columnheader">App</span>
              <span role="columnheader">People</span>
              <span role="columnheader">Type</span>
              <span role="columnheader" className="oxp-actions--head">
                Actions
              </span>
            </div>
            {shownGroups.flatMap((g) =>
              g.roles.map((role) => {
                const key = role.key;
                const open = openKey === key;
                const holders = live.filter((u) => u.role_keys.includes(key));
                const others = live.filter((u) => !u.role_keys.includes(key));
                const ownerLocked = key === OWNER_ROLE_KEY && !callerIsOwner;
                const permsHref = g.key === 'ats' ? ATS_ROLES_HREF : g.key === 'sign' ? signHref : null;
                return (
                  <div key={key} className={`oxp-roleblock${open ? ' oxp-roleblock--open' : ''}`} data-testid={`role-row-${key}`}>
                    <div className="ox-tr oxp-roles-row" role="row" style={{ gridTemplateColumns: COLS }}>
                      <span role="cell" className="oxp-role">
                        <span className={`oxp-tile oxp-app--${g.key}`} aria-hidden="true">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d={ICON[g.key]} />
                          </svg>
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="oxp-role__name">{role.display}</span>
                          {role.description.length > 0 ? <span className="oxp-role__desc">{role.description}</span> : null}
                        </span>
                      </span>
                      <span role="cell">
                        <span className={`oxp-apppill oxp-app--${g.key}`}>{g.app}</span>
                      </span>
                      <span role="cell">
                        <button
                          type="button"
                          className="oxp-people"
                          title={holders.map(personName).join(', ')}
                          aria-expanded={open}
                          onClick={() => toggleRow(key, others)}
                          data-testid={`people-${key}`}
                        >
                          {holders.length > 0 ? (
                            <span className="oxp-faces" aria-hidden="true">
                              {holders.slice(0, 4).map((u) => (
                                <OrgAvatar key={u.user_id} name={personName(u)} seed={u.user_id} size={26} />
                              ))}
                              {holders.length > 4 ? <span className="oxp-more">+{holders.length - 4}</span> : null}
                            </span>
                          ) : null}
                          <span className={`oxp-count${holders.length === 0 ? ' oxp-count--none' : ''}`}>
                            {holders.length === 0 ? 'No one' : `${holders.length} ${holders.length === 1 ? 'person' : 'people'}`}
                          </span>
                        </button>
                      </span>
                      <span role="cell" className="oxp-type">
                        Aramo default
                      </span>
                      <span role="cell" className="oxp-actions">
                        <button type="button" className="ox-link" aria-expanded={open} onClick={() => toggleRow(key, others)} data-testid={`manage-${key}`}>
                          {open ? 'Done' : 'Manage people'}
                        </button>
                        {permsHref !== null ? (
                          <a className="ox-link" href={permsHref}>
                            Permissions ↗
                          </a>
                        ) : null}
                      </span>
                    </div>
                    {open ? (
                      <div className="oxp-open" data-testid={`open-${key}`}>
                        <div className="oxp-chips">
                          {holders.map((u) => (
                            <span key={u.user_id} className="oxp-pchip">
                              <OrgAvatar name={personName(u)} seed={u.user_id} size={20} />
                              {personName(u)}
                              <button
                                type="button"
                                className="oxp-pchip__x"
                                aria-label={`Remove ${personName(u)} from ${role.display}`}
                                disabled={busy || ownerLocked}
                                title={ownerLocked ? OWNER_ONLY_HINT : undefined}
                                onClick={() => remove(role, holders, u)}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {holders.length === 0 ? <span className="oxp-count--none" style={{ fontSize: 12.5 }}>No one has this role yet.</span> : null}
                        </div>
                        {ownerLocked ? <span className="ox-hint">{OWNER_ONLY_HINT}</span> : null}
                        {others.length > 0 ? (
                          <div className="oxp-add">
                            <select className="ox-select" aria-label="Person to add" value={addPick} disabled={ownerLocked} onChange={(e) => setAddPick(e.target.value)}>
                              {others.map((u) => (
                                <option key={u.user_id} value={u.user_id}>
                                  {`${personName(u)} · ${u.email}`}
                                </option>
                              ))}
                            </select>
                            <button type="button" className="ox-btn ox-btn--secondary ox-btn--sm" disabled={busy || ownerLocked} onClick={() => add(role, others)}>
                              Add to role
                            </button>
                          </div>
                        ) : null}
                        {rowError !== null ? (
                          <div className="ox-alert ox-alert--error" role="alert">
                            {rowError}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              }),
            )}
          </div>
        </div>
        {subs.sign && (filter === 'all' || filter === 'sign') && dir.status === 'ready' ? (
          <RemoveSignAccess people={live} roleName={(k) => catalog.find((r) => r.key === k)?.display ?? k} onRemoved={dir.reload} />
        ) : null}
        <div className="oxp-roles-foot">{"Roles come from each app and can't be renamed here. Custom roles aren't available yet."}</div>
      </div>
    </div>
  );
}
