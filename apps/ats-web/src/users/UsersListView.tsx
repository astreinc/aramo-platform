import { useEffect, useState } from 'react';
import { useToast } from '@aramo/fe-foundation';

import {
  Button,
  Card,
  DataTable,
  InlineAlert,
  StatusPill,
  Tag,
  type TableColumn,
} from '../ui';
import { SettingsSection } from '../settings/components';

import { DisableConfirmDialog } from './DisableConfirmDialog';
import { EditEmailDialog } from './EditEmailDialog';
import { InviteDialog } from './InviteDialog';
import { RevokeConfirmDialog } from './RevokeConfirmDialog';
import { RoleAssignEditor } from './RoleAssignEditor';
import { messageForLifecycleActionError } from './error-messages';
import type { TenantRoleCatalogEntry, TenantUserView } from './types';
import {
  STATUS_LABEL,
  STATUS_TONE,
  actionsForUser,
  deriveDisplayedStatus,
} from './user-status';
import {
  enableTenantUser,
  fetchPickerRoles,
  fetchTenantUsers,
  probeFinancialsToggle,
  resendTenantInvitation,
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
  // Settings Rebuild D5 — the roles catalog (drives the RolePicker + the role
  // labels in the roster). Sourced from GET /v1/tenant/roles-catalog.
  rolesFn?: () => Promise<readonly TenantRoleCatalogEntry[]>;
  // Invite-S3 — the inline lifecycle actions (test seams).
  enableFn?: typeof enableTenantUser;
  resendFn?: typeof resendTenantInvitation;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; users: readonly TenantUserView[] }
  | { status: 'error'; message: string };

// Invite-S3 (§0/§2) — the 5-state badge. The displayed status layers the two
// orthogonal axes (is_active overrides → INACTIVE; else invite_status), mapped
// to a StatusPill tone via the STATUS_TONE record.
function StatusBadge({ user }: { user: TenantUserView }) {
  const displayed = deriveDisplayedStatus(user);
  return (
    <span data-testid={`user-status-${user.user_id}`}>
      <StatusPill tone={STATUS_TONE[displayed]}>
        {STATUS_LABEL[displayed]}
      </StatusPill>
    </span>
  );
}

function RoleChips({
  role_keys,
  labelOf,
}: {
  role_keys: readonly string[];
  labelOf: (key: string) => string;
}) {
  if (role_keys.length === 0) {
    return <span className="rc-muted-line">—</span>;
  }
  return (
    <span className="rc-tags">
      {role_keys.map((key) => (
        <Tag key={key}>{labelOf(key)}</Tag>
      ))}
    </span>
  );
}

export function UsersListView({
  fetchUsersFn,
  probeFinancialsFn,
  rolesFn,
  enableFn,
  resendFn,
}: Props = {}) {
  const fetchUsers = fetchUsersFn ?? fetchTenantUsers;
  const probe = probeFinancialsFn ?? probeFinancialsToggle;
  const loadRoles = rolesFn ?? fetchPickerRoles;
  const enable = enableFn ?? enableTenantUser;
  const resend = resendFn ?? resendTenantInvitation;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [financialsToggle, setFinancialsToggle] =
    useState<FinancialsToggleState>({ state: 'unknown' });
  const [roles, setRoles] = useState<readonly TenantRoleCatalogEntry[]>([]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<TenantUserView | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<TenantUserView | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<TenantUserView | null>(null);
  const [editEmailTarget, setEditEmailTarget] = useState<TenantUserView | null>(
    null,
  );
  // Invite-S3 — the in-flight inline action (enable / resend), keyed by
  // user_id, so a row's buttons disable while its action runs.
  const [busyId, setBusyId] = useState<string | null>(null);

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
    loadRoles()
      .then((next) => {
        if (!cancelled) setRoles(next);
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchUsers, probe, loadRoles]);

  const roleLabelOf = (key: string): string =>
    roles.find((r) => r.key === key)?.label ?? key;

  // Invite-S3 — the inline (no-dialog) actions: enable + resend. Both are
  // non-destructive; they run on click, toast, and refresh. The destructive
  // actions (disable, revoke) and the email edit go through dialogs.
  const handleEnable = async (u: TenantUserView) => {
    setBusyId(u.user_id);
    try {
      await enable(u.user_id);
      toast.show(`Enabled ${u.email}.`);
      refresh();
    } catch (err: unknown) {
      toast.show(messageForLifecycleActionError(err).title);
    } finally {
      setBusyId(null);
    }
  };

  const handleResend = async (u: TenantUserView) => {
    setBusyId(u.user_id);
    try {
      const { sent } = await resend(u.user_id);
      toast.show(
        sent === 'confirmation'
          ? `Sign-in reminder re-sent to ${u.email}.`
          : `Invitation re-sent to ${u.email}.`,
      );
      refresh();
    } catch (err: unknown) {
      toast.show(messageForLifecycleActionError(err).title);
    } finally {
      setBusyId(null);
    }
  };

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
      render: (u) => <RoleChips role_keys={u.role_keys} labelOf={roleLabelOf} />,
    },
    // The action buttons are grouped into three labelled columns so the table
    // has a header for every column and each action sits in a fixed position
    // across rows (previously one far-right unlabelled cell, where buttons
    // clustered at the edge and never lined up row-to-row). The grouping mirrors
    // the §3 matrix axes: Permissions (role-set), Invitations (the invite
    // lifecycle: resend + edit-email), Access (membership access: revoke /
    // enable / disable). Each cell preserves its Invite-S3 testids, handlers,
    // and busy-disable behaviour verbatim.
    {
      key: 'permissions',
      header: 'Permissions',
      width: '120px',
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
        </span>
      ),
    },
    {
      key: 'invitations',
      header: 'Invitations',
      width: '160px',
      align: 'right',
      render: (u) => {
        const actions = actionsForUser(u);
        const busy = busyId === u.user_id;
        return (
          <span className="rc-rowactions">
            {actions.resend !== null && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => handleResend(u)}
                data-testid={`resend-${u.user_id}`}
              >
                Resend
              </Button>
            )}
            {actions.editEmail && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setEditEmailTarget(u)}
                data-testid={`edit-email-${u.user_id}`}
              >
                Edit email
              </Button>
            )}
          </span>
        );
      },
    },
    {
      key: 'access',
      header: 'Access',
      width: '120px',
      align: 'right',
      render: (u) => {
        const actions = actionsForUser(u);
        const busy = busyId === u.user_id;
        return (
          <span className="rc-rowactions">
            {actions.revoke && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setRevokeTarget(u)}
                data-testid={`revoke-${u.user_id}`}
              >
                Revoke
              </Button>
            )}
            {actions.enable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => handleEnable(u)}
                data-testid={`enable-${u.user_id}`}
              >
                Enable
              </Button>
            )}
            {actions.disable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setDisableTarget(u)}
                data-testid={`disable-${u.user_id}`}
              >
                Disable
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    // People & access — Users renders inside the SettingsShell rail alongside
    // Roles & permissions, so it uses the SAME section grammar (SettingsSection
    // → .set-content padding + max-width, .set-head title) as every other
    // settings section. (It previously used a raw rc-stack + the retired
    // tenant-console PageHeader, which has no styling in ats-web — leaving the
    // page flush/full-width with an unstyled oversized title, misaligned with
    // its rail-mates.)
    <SettingsSection
      title="Users"
      description="Invite, edit roles, and disable users in your tenant."
    >
      <div className="rc-stack">
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
      </div>
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => refresh()}
        financialsToggle={financialsToggle}
        roles={roles}
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
        roles={roles}
      />
      <RevokeConfirmDialog
        user={revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        onRevoked={() => refresh()}
      />
      <EditEmailDialog
        user={editEmailTarget}
        onOpenChange={(open) => {
          if (!open) setEditEmailTarget(null);
        }}
        onSaved={() => refresh()}
      />
    </SettingsSection>
  );
}
