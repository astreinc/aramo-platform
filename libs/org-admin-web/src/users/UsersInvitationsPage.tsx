import { useMemo, useState } from 'react';
import { useToast, type ProductAvailabilityView, type Session } from '@aramo/fe-foundation';

import type { RoleCatalogView } from '../roles/roles-catalog-api';
import { OrgAvatar, OrgCheck, OrgPageHeader, SearchIcon } from '../ui/OrgPage';

import { isOwner, personName, useDirectory } from './directory';
import { EditAccessModal } from './EditAccessModal';
import { InviteUserModal } from './InviteUserModal';
import { buildRoleGroups, roleWriteErrorMessage, shortSignLabel, splitUserRoles, subscribedApps, type UserRoleSplit } from './role-groups';
import type { TenantUserView } from './types';
import { deriveDisplayedStatus, STATUS_LABEL, type DisplayedStatus } from './user-status';
import { disableTenantUser, enableTenantUser, resendTenantInvitation, revokeTenantInvitation } from './users-api';

import './org-people.css';

// ORG-UX-1 (handoff §6.3; Directive v1.0 LOCKED §8.3, §13.1) — Users & invitations.
// Search + App access filter + five status tabs (H9) combine; the tab counts follow the
// filters. Bulk Resend / Disable skip yourself (session.sub; the server also refuses a
// self-disable). Every action is an existing D-ORG call; the server writes the audit.
// Last sign-in is a data gap (G3): "—"; invites show "Invited {date}" from invited_at (G4).

type TabKey = 'all' | DisplayedStatus;
type AppFilter = 'all' | 'ats' | 'sign' | 'none';

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'INVITED', label: 'Invited' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'INACTIVE', label: 'Disabled' },
  { key: 'FAILED', label: 'Failed' },
];

const PILL: Readonly<Record<DisplayedStatus, string>> = {
  INVITED: 'ox-pill--invited',
  ACCEPTED: 'ox-pill--invited',
  ACTIVE: 'ox-pill--active',
  INACTIVE: 'ox-pill--disabled',
  FAILED: 'ox-pill--failed',
};

const NO_USERS: readonly TenantUserView[] = [];
const NO_ROLES: readonly RoleCatalogView[] = [];

const PENDING: readonly DisplayedStatus[] = ['INVITED', 'ACCEPTED', 'FAILED'];
const COLS = '34px minmax(220px,1.6fr) 150px minmax(200px,1.5fr) 96px 116px 170px';

function invitedLabel(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `Invited ${d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

interface Row {
  readonly user: TenantUserView;
  readonly name: string;
  readonly status: DisplayedStatus;
  readonly split: UserRoleSplit;
}

export function UsersInvitationsPage({ session, products }: { readonly session?: Session; readonly products?: ProductAvailabilityView | null }) {
  const toast = useToast();
  const dir = useDirectory();
  const subs = useMemo(() => subscribedApps(products), [products]);
  const me = session?.sub ?? null;

  const [q, setQ] = useState('');
  const [app, setApp] = useState<AppFilter>('all');
  const [tab, setTab] = useState<TabKey>('all');
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<TenantUserView | null>(null);
  const [busy, setBusy] = useState(false);

  const users = dir.status === 'ready' ? dir.users : NO_USERS;
  const catalog = dir.status === 'ready' ? dir.catalog : NO_ROLES;
  const rows: readonly Row[] = useMemo(
    () => users.map((u) => ({ user: u, name: personName(u), status: deriveDisplayedStatus(u), split: splitUserRoles(u.role_keys, catalog) })),
    [users, catalog],
  );
  const groups = useMemo(() => buildRoleGroups(catalog, subs), [catalog, subs]);
  const callerIsOwner = isOwner(users.find((u) => u.user_id === me));

  // Filters (search + app) → the base the tab counts are computed over.
  const needle = q.trim().toLowerCase();
  const base = rows.filter((r) => {
    if (needle.length > 0 && !`${r.name} ${r.user.email}`.toLowerCase().includes(needle)) return false;
    const hasAts = subs.ats && r.split.ats.length > 0;
    const hasSign = subs.sign && r.split.sign.length > 0;
    if (app === 'ats') return hasAts;
    if (app === 'sign') return hasSign;
    if (app === 'none') return !hasAts && !hasSign;
    return true;
  });
  const countOf = (k: TabKey) => (k === 'all' ? base.length : base.filter((r) => r.status === k).length);
  const shown = tab === 'all' ? base : base.filter((r) => r.status === tab);
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const pageIdx = Math.min(page, pages - 1);
  const visible = shown.slice(pageIdx * pageSize, pageIdx * pageSize + pageSize);
  const selectedRows = shown.filter((r) => sel.has(r.user.user_id));
  const allOn: boolean | 'mixed' = visible.length > 0 && visible.every((r) => sel.has(r.user.user_id)) ? true : visible.some((r) => sel.has(r.user.user_id)) ? 'mixed' : false;
  const filtered = needle.length > 0 || app !== 'all';

  const resetPaging = () => {
    setPage(0);
    setSel(new Set());
  };
  const reload = () => {
    setSel(new Set());
    dir.reload();
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show(ok);
      dir.reload();
    } catch (err: unknown) {
      toast.show(roleWriteErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bulkResend = async () => {
    const targets = selectedRows.filter((r) => PENDING.includes(r.status) && r.user.user_id !== me);
    setSel(new Set());
    if (targets.length === 0) {
      toast.show('None of the selected people have a pending invitation.');
      return;
    }
    setBusy(true);
    const res = await Promise.allSettled(targets.map((r) => resendTenantInvitation(r.user.user_id)));
    setBusy(false);
    const okN = res.filter((x) => x.status === 'fulfilled').length;
    const failN = res.length - okN;
    toast.show(`${okN} invitation${okN === 1 ? '' : 's'} resent.${failN > 0 ? ` ${failN} couldn’t be resent.` : ''}`);
    dir.reload();
  };

  const bulkDisable = async () => {
    const targets = selectedRows.filter((r) => r.status === 'ACTIVE' && r.user.user_id !== me);
    const skippedSelf = selectedRows.some((r) => r.user.user_id === me);
    setSel(new Set());
    const selfNote = skippedSelf ? ' You can’t disable yourself.' : '';
    if (targets.length === 0) {
      toast.show(`Nothing to disable.${selfNote}`);
      return;
    }
    setBusy(true);
    const res = await Promise.allSettled(targets.map((r) => disableTenantUser({ userId: r.user.user_id, reason: null })));
    setBusy(false);
    const okN = res.filter((x) => x.status === 'fulfilled').length;
    const failN = res.length - okN;
    toast.show(`${okN} disabled.${selfNote}${failN > 0 ? ` ${failN} couldn’t be disabled.` : ''}`);
    dir.reload();
  };

  const actionsFor = (r: Row) => {
    const u = r.user;
    const self = u.user_id === me;
    if (r.status === 'ACTIVE') {
      return (
        <>
          <button type="button" className="ox-link" onClick={() => setEditing(u)} data-testid={`edit-access-${u.user_id}`}>
            Edit access
          </button>
          <button
            type="button"
            className="ox-link ox-link--danger"
            disabled={busy || self}
            title={self ? 'You can’t disable yourself.' : undefined}
            data-testid={`disable-${u.user_id}`}
            onClick={() => void run(() => disableTenantUser({ userId: u.user_id, reason: null }), `${r.name} can no longer sign in. Their history stays.`)}
          >
            Disable
          </button>
        </>
      );
    }
    if (PENDING.includes(r.status)) {
      return (
        <>
          <button type="button" className="ox-link" disabled={busy} data-testid={`resend-${u.user_id}`} onClick={() => void run(() => resendTenantInvitation(u.user_id), `Invitation resent to ${u.email}`)}>
            Resend
          </button>
          <button type="button" className="ox-link ox-link--danger" disabled={busy} data-testid={`revoke-${u.user_id}`} onClick={() => void run(() => revokeTenantInvitation(u.user_id), 'Invitation revoked.')}>
            Revoke
          </button>
        </>
      );
    }
    return (
      <button type="button" className="ox-link" disabled={busy} data-testid={`enable-${u.user_id}`} onClick={() => void run(() => enableTenantUser(u.user_id), `${r.name} can sign in again.`)}>
        Enable
      </button>
    );
  };

  const appChips = (r: Row) => {
    const chips: { key: string; label: string; full: string }[] = [];
    if (subs.ats && r.split.ats.length > 0) {
      const [first, ...rest] = r.split.ats;
      chips.push({ key: 'ats', label: `ATS · ${first}${rest.length > 0 ? ` +${rest.length}` : ''}`, full: `ATS: ${r.split.ats.join(', ')}` });
    }
    if (subs.sign && r.split.sign.length > 0) {
      const [first = '', ...rest] = r.split.sign;
      chips.push({ key: 'sign', label: `Sign · ${shortSignLabel(first)}${rest.length > 0 ? ` +${rest.length}` : ''}`, full: `Sign: ${r.split.sign.join(', ')}` });
    }
    if (chips.length === 0) return <span className="oxp-noapps">No app access</span>;
    return chips.map((c) => (
      <span key={c.key} className="oxp-appchip" title={c.full}>
        {c.label}
      </span>
    ));
  };

  return (
    <div data-testid="org-users-page">
      <OrgPageHeader
        section="users"
        actions={
          <button type="button" className="ox-btn ox-btn--primary" onClick={() => setInviteOpen(true)} data-testid="open-invite">
            Invite user
          </button>
        }
      />
      <div className="oxp-stack">
        <div className="ox-toolbar" style={{ marginBottom: 0 }}>
          <span className="ox-search">
            <SearchIcon />
            <input
              className="ox-input"
              aria-label="Search people"
              placeholder="Search name or email"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                resetPaging();
              }}
            />
          </span>
          <select
            className="ox-select oxp-appsel"
            aria-label="App access"
            value={app}
            onChange={(e) => {
              setApp(e.target.value as AppFilter);
              resetPaging();
            }}
          >
            <option value="all">All apps</option>
            {subs.ats ? <option value="ats">Aramo ATS</option> : null}
            {subs.sign ? <option value="sign">Aramo Sign</option> : null}
            <option value="none">No app access</option>
          </select>
          {filtered ? (
            <button
              type="button"
              className="oxp-clear"
              onClick={() => {
                setQ('');
                setApp('all');
                resetPaging();
              }}
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="ox-tabs" role="tablist" aria-label="Status" style={{ marginBottom: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              className="ox-tab"
              aria-selected={tab === t.key}
              data-testid={`tab-${t.key}`}
              onClick={() => {
                setTab(t.key);
                resetPaging();
              }}
            >
              {t.label}
              <span className="ox-count">{countOf(t.key)}</span>
            </button>
          ))}
        </div>

        {selectedRows.length > 0 ? (
          <div className="oxp-bulk" role="status" data-testid="bulk-bar">
            <b>{selectedRows.length} selected</b>
            <button type="button" className="ox-link" disabled={busy} onClick={() => void bulkResend()}>
              Resend invitations
            </button>
            <button type="button" className="ox-link ox-link--danger" disabled={busy} onClick={() => void bulkDisable()}>
              Disable
            </button>
            <button type="button" className="ox-link ox-link--muted oxp-bulk__end" onClick={() => setSel(new Set())}>
              Clear selection
            </button>
          </div>
        ) : null}

        {dir.status === 'error' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            We couldn’t load your people.{' '}
            <button type="button" className="ox-link" onClick={dir.reload}>
              Try again
            </button>
          </div>
        ) : null}

        <div className="ox-card oxp-table">
          <div role="table" aria-label="People" aria-busy={dir.status === 'loading'}>
            <div className="ox-tr ox-tr--head oxp-users-row" role="row" style={{ gridTemplateColumns: COLS }}>
              <span role="columnheader">
                <OrgCheck
                  checked={allOn}
                  label="Select all"
                  onChange={(on) =>
                    setSel((prev) => {
                      const next = new Set(prev);
                      for (const r of visible) {
                        if (on) next.add(r.user.user_id);
                        else next.delete(r.user.user_id);
                      }
                      return next;
                    })
                  }
                />
              </span>
              <span role="columnheader">Person</span>
              <span role="columnheader">Organization</span>
              <span role="columnheader">App access</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Last sign-in</span>
              <span role="columnheader" className="oxp-actions--head">
                Actions
              </span>
            </div>
            {visible.map((r) => {
              const on = sel.has(r.user.user_id);
              return (
                <div
                  key={r.user.user_id}
                  role="row"
                  className={`ox-tr oxp-users-row${on ? ' ox-tr--selected' : ''}`}
                  style={{ gridTemplateColumns: COLS }}
                  data-testid={`user-row-${r.user.user_id}`}
                >
                  <span role="cell">
                    <OrgCheck
                      checked={on}
                      label={`Select ${r.name}`}
                      onChange={(next) =>
                        setSel((prev) => {
                          const s = new Set(prev);
                          if (next) s.add(r.user.user_id);
                          else s.delete(r.user.user_id);
                          return s;
                        })
                      }
                    />
                  </span>
                  <span role="cell" className="oxp-person">
                    <OrgAvatar name={r.name} seed={r.user.user_id} />
                    <span className="oxp-person__text">
                      <span className="oxp-person__name ox-ellipsis">{r.name}</span>
                      <span className="oxp-person__email ox-ellipsis">{r.user.email}</span>
                    </span>
                  </span>
                  <span role="cell" className="oxp-orgrole">
                    {r.split.org.length > 0 ? r.split.org.join(', ') : 'Member'}
                  </span>
                  <span role="cell" className="oxp-apps">
                    {appChips(r)}
                  </span>
                  <span role="cell">
                    <span className={`ox-pill ${PILL[r.status]}`} data-testid={`status-${r.user.user_id}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </span>
                  <span role="cell" className="oxp-last">
                    {PENDING.includes(r.status) ? invitedLabel(r.user.invited_at) : '—'}
                  </span>
                  <span role="cell" className="oxp-actions">
                    {actionsFor(r)}
                  </span>
                </div>
              );
            })}
          </div>
          {dir.status === 'ready' && shown.length === 0 ? <div className="ox-empty">No one matches these filters.</div> : null}
          <div className="oxp-foot">
            <select
              className="ox-select"
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                resetPaging();
              }}
            >
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
              <option value={100}>100 per page</option>
            </select>
            <span className="oxp-foot__range" data-testid="users-range">
              {shown.length === 0 ? '0 of 0' : `${pageIdx * pageSize + 1}–${pageIdx * pageSize + visible.length} of ${shown.length}`}
              {pages > 1 ? (
                <>
                  <button type="button" className="ox-link" disabled={pageIdx === 0} onClick={() => setPage(pageIdx - 1)}>
                    Previous
                  </button>
                  <button type="button" className="ox-link" disabled={pageIdx >= pages - 1} onClick={() => setPage(pageIdx + 1)}>
                    Next
                  </button>
                </>
              ) : null}
            </span>
          </div>
        </div>
      </div>

      <InviteUserModal open={inviteOpen} onOpenChange={setInviteOpen} onInvited={reload} />
      <EditAccessModal
        user={editing}
        groups={groups}
        callerIsOwner={callerIsOwner}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={reload}
      />
    </div>
  );
}
