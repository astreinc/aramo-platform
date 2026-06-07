import { useEffect, useState } from 'react';

import { Button } from '../components/Button';
import { InlineAlert } from '../components/InlineAlert';
import { PageHeader } from '../components/PageHeader';
import { Table, type TableColumn } from '../components/Table';

import { DisableConfirmDialog } from './DisableConfirmDialog';
import { InviteDialog } from './InviteDialog';
import { RoleAssignEditor } from './RoleAssignEditor';
import { findRoleEntry, type TenantUserView } from './types';
import {
  fetchTenantUsers,
  probeFinancialsToggle,
  type FinancialsToggleState,
} from './users-api';

// Settings S5b — UsersListView.
//
// The roster + the three actions (Invite / Disable / Edit roles).
// Composes on the S5a foundation (PageHeader + InlineAlert + the new
// Table) and orchestrates the three Dialogs. The financials toggle
// probe (ruling 4) runs in parallel with the user-list fetch; it is
// passed into the two role-bearing Dialogs so the picker can reflect
// the S4 gate proactively.

interface Props {
  // Test seams — let the tests inject fetchers and avoid touching
  // global fetch when they only care about render shape.
  fetchUsersFn?: () => Promise<{ items: readonly TenantUserView[] }>;
  probeFinancialsFn?: () => Promise<FinancialsToggleState>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; users: readonly TenantUserView[] }
  | { status: 'error'; message: string };

function StatusBadge({ user }: { user: TenantUserView }) {
  if (user.is_active) {
    return (
      <span
        className="tc-badge tc-badge--active"
        data-testid={`user-status-${user.user_id}`}
      >
        Active
      </span>
    );
  }
  return (
    <span
      className="tc-badge tc-badge--disabled"
      data-testid={`user-status-${user.user_id}`}
    >
      Disabled
    </span>
  );
}

function RoleChips({ role_keys }: { role_keys: readonly string[] }) {
  if (role_keys.length === 0) {
    return <span className="tc-helper">—</span>;
  }
  return (
    <>
      {role_keys.map((key) => (
        <span key={key} className="tc-badge tc-badge--role">
          {findRoleEntry(key)?.label ?? key}
        </span>
      ))}
    </>
  );
}

export function UsersListView({
  fetchUsersFn,
  probeFinancialsFn,
}: Props = {}) {
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
        // A non-403 probe failure: fall back to 'unknown' silently. The
        // BE rejection is the floor — the picker still works.
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
          <div className="tc-helper">{u.email}</div>
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
      header: 'Actions',
      width: '220px',
      align: 'right',
      render: (u) => (
        <>
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
        </>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Users"
        description="Invite, edit roles, and disable users in your tenant."
      />
      <div className="tc-page-actions">
        <span className="tc-helper">
          {state.status === 'ready'
            ? `${state.users.length} user${state.users.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button
          onClick={() => setInviteOpen(true)}
          data-testid="open-invite"
        >
          Invite user
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="tc-helper">Loading users…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <Table<TenantUserView>
          columns={columns}
          rows={state.users}
          rowKey={(u) => u.user_id}
          rowMuted={(u) => !u.is_active}
          emptyMessage="No users yet. Invite one to get started."
        />
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
