import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  DataTable,
  InlineAlert,
  PageHeader,
  StatusPill,
  Tag,
  type TableColumn,
} from '../ui';

import { DisableConfirmDialog } from './DisableConfirmDialog';
import { InviteDialog } from './InviteDialog';
import { RoleAssignEditor } from './RoleAssignEditor';
import { findRoleEntry, type TenantUserView } from './types';
import {
  fetchTenantUsers,
  probeFinancialsToggle,
  type FinancialsToggleState,
} from './users-api';

// UsersListView at /admin/users (ported to ats-web, FE Consolidation Directive
// 5 PR3; restyled to Confident Blue). The roster + the three actions (Invite /
// Disable / Edit roles). The financials-toggle probe (ruling 4) runs in
// parallel with the user-list fetch and is passed into the two role-bearing
// Dialogs so the picker reflects the S4 gate proactively. The D5 role-bundle
// logic + the S4 gate are preserved verbatim from S5b (RoleAssignEditor +
// RolePicker + error-messages) — only the chrome is restyled.

interface Props {
  fetchUsersFn?: () => Promise<{ items: readonly TenantUserView[] }>;
  probeFinancialsFn?: () => Promise<FinancialsToggleState>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; users: readonly TenantUserView[] }
  | { status: 'error'; message: string };

function StatusBadge({ user }: { user: TenantUserView }) {
  return (
    <span data-testid={`user-status-${user.user_id}`}>
      <StatusPill tone={user.is_active ? 'ok' : 'neutral'}>
        {user.is_active ? 'Active' : 'Disabled'}
      </StatusPill>
    </span>
  );
}

function RoleChips({ role_keys }: { role_keys: readonly string[] }) {
  if (role_keys.length === 0) {
    return <span className="rc-muted-line">—</span>;
  }
  return (
    <span className="rc-tags">
      {role_keys.map((key) => (
        <Tag key={key}>{findRoleEntry(key)?.label ?? key}</Tag>
      ))}
    </span>
  );
}

export function UsersListView({ fetchUsersFn, probeFinancialsFn }: Props = {}) {
  const fetchUsers = fetchUsersFn ?? fetchTenantUsers;
  const probe = probeFinancialsFn ?? probeFinancialsToggle;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [financialsToggle, setFinancialsToggle] =
    useState<FinancialsToggleState>({ state: 'unknown' });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<TenantUserView | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<TenantUserView | null>(null);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchUsers()
      .then((view) => setState({ status: 'ready', users: view.items }))
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to load users.';
        setState({ status: 'error', message });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchUsers()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', users: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load users.';
        setState({ status: 'error', message });
      });
    probe()
      .then((next) => {
        if (cancelled) return;
        setFinancialsToggle(next);
      })
      .catch(() => {
        if (cancelled) return;
        setFinancialsToggle({ state: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchUsers, probe]);

  const columns: ReadonlyArray<TableColumn<TenantUserView>> = [
    {
      key: 'name',
      header: 'Name',
      render: (u) => (
        <>
          <div>{u.display_name ?? '—'}</div>
          <div className="rc-cell-sub">{u.email}</div>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (u) => <StatusBadge user={u} />,
    },
    {
      key: 'roles',
      header: 'Roles',
      render: (u) => <RoleChips role_keys={u.role_keys} />,
    },
    {
      key: 'actions',
      header: '',
      width: '220px',
      align: 'right',
      render: (u) => (
        <span className="rc-rowactions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditTarget(u)}
            data-testid={`edit-roles-${u.user_id}`}
          >
            Edit roles
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!u.is_active}
            onClick={() => setDisableTarget(u)}
            data-testid={`disable-${u.user_id}`}
          >
            Disable
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section className="rc-stack">
      <PageHeader
        title="Users"
        description="Invite, edit roles, and disable users in your tenant."
      />
      <div className="rc-formfoot">
        <span className="rc-muted-line">
          {state.status === 'ready'
            ? `${state.users.length} user${state.users.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button onClick={() => setInviteOpen(true)} data-testid="open-invite">
          Invite user
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading users…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <Card flush>
          <DataTable<TenantUserView>
            columns={columns}
            rows={state.users}
            rowKey={(u) => u.user_id}
            rowMuted={(u) => !u.is_active}
            emptyMessage="No users yet. Invite one to get started."
          />
        </Card>
      )}
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => refresh()}
        financialsToggle={financialsToggle}
      />
      <DisableConfirmDialog
        user={disableTarget}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        onDisabled={() => refresh()}
      />
      <RoleAssignEditor
        user={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        onSaved={() => refresh()}
        financialsToggle={financialsToggle}
      />
    </section>
  );
}
