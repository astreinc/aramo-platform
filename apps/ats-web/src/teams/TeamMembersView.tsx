import { ApiError, Combobox, type ComboboxItem, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  Button,
  Card,
  CardHead,
  DataTable,
  InlineAlert,
  PageHeader,
  type TableColumn,
} from '../ui';
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

import {
  messageForAddMemberError,
  messageForFetchTeamMembersError,
  messageForRemoveMemberError,
  type ErrorMessage,
} from './error-messages';
import { addMember, fetchTeamMembers, removeMember } from './teams-api';
import type { TeamMembershipRow } from './types';

// TeamMembersView at /admin/teams/:teamId (ported to ats-web, FE Consolidation
// Directive 5; restyled to Confident Blue). Combobox-add (non-members pre-
// filtered) + inline-confirm remove; idempotency mirrored (add dup silent;
// DELETE 404 success). Roster-403 → raw-UUID fallback. The "Manage clients"
// link (de-wired in D4) is re-homed here to /admin/teams/:teamId/clients.

interface Props {
  teamIdOverride?: string;
  fetchMembersFn?: (teamId: string) => Promise<{ items: readonly TeamMembershipRow[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
  addMemberFn?: typeof addMember;
  removeMemberFn?: typeof removeMember;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; members: readonly TeamMembershipRow[] }
  | { status: 'error'; message: string };

interface PendingRemoval {
  readonly userId: string;
  readonly stage: 'confirm' | 'removing';
}

function rosterToItems(
  users: readonly AssignableUser[],
  memberUserIds: ReadonlySet<string>,
): ReadonlyArray<ComboboxItem> {
  return [...users]
    .filter((u) => !memberUserIds.has(u.user_id))
    .sort((a, b) =>
      (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id),
    )
    .map((u) => ({ value: u.user_id, label: u.display_name ?? u.user_id }));
}

export function TeamMembersView({
  teamIdOverride,
  fetchMembersFn,
  fetchAssignableFn,
  resolveNamesFn,
  addMemberFn,
  removeMemberFn,
}: Props = {}) {
  const params = useParams<{ teamId?: string }>();
  const teamId = teamIdOverride ?? params.teamId ?? '';

  const fetchMembersFun = fetchMembersFn ?? fetchTeamMembers;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;
  const addMemberFun = addMemberFn ?? addMember;
  const removeMemberFun = removeMemberFn ?? removeMember;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pickerUsers, setPickerUsers] = useState<readonly AssignableUser[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [pickerValue, setPickerValue] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<ErrorMessage | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchMembersFun(teamId)
      .then((view) => setState({ status: 'ready', members: view.items }))
      .catch((err: unknown) => {
        const msg = messageForFetchTeamMembersError(err);
        setState({ status: 'error', message: msg.title });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchMembersFun(teamId)
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', members: view.items });
        // Member NAMES from the directory (incl. departed members).
        void resolveNamesFun(view.items.map((m) => m.user_id)).then((map) => {
          if (!cancelled) setNames(map);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchTeamMembersError(err);
        setState({ status: 'error', message: msg.title });
      });
    void fetchAssignableFun()
      .then((users) => {
        if (!cancelled) setPickerUsers(users);
      })
      .catch(() => {
        if (!cancelled) setPickerUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchMembersFun, fetchAssignableFun, resolveNamesFun, teamId]);

  const memberUserIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') {
      for (const m of state.members) s.add(m.user_id);
    }
    return s;
  }, [state]);

  const comboboxItems = useMemo(
    () => rosterToItems(pickerUsers, memberUserIds),
    [pickerUsers, memberUserIds],
  );

  const onAdd = async () => {
    const targetUserId = pickerValue;
    if (targetUserId === null || targetUserId.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await addMemberFun({ teamId, body: { user_id: targetUserId } });
      toast.show('Member added.');
      setPickerValue(null);
      refresh();
    } catch (err: unknown) {
      setAddError(messageForAddMemberError(err));
    } finally {
      setAdding(false);
    }
  };

  const onConfirmRemove = async () => {
    if (pendingRemoval === null) return;
    const userId = pendingRemoval.userId;
    setPendingRemoval({ userId, stage: 'removing' });
    try {
      await removeMemberFun({ teamId, userId });
      toast.show('Member removed.');
      setPendingRemoval(null);
      refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        toast.show('Member already removed.');
        setPendingRemoval(null);
        refresh();
        return;
      }
      const msg = messageForRemoveMemberError(err);
      toast.show(msg.title);
      setPendingRemoval(null);
    }
  };

  const canAdd = !adding && pickerValue !== null;

  const columns: ReadonlyArray<TableColumn<TeamMembershipRow>> = [
    {
      key: 'member',
      header: 'Member',
      render: (m) => {
        const name = names[m.user_id] ?? m.user_id;
        return (
          <span data-testid={`member-row-${m.user_id}`}>
            <span>{name}</span>
          </span>
        );
      },
    },
    {
      key: 'added',
      header: 'Added',
      render: (m) => new Date(m.added_at).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (m) => {
        const isPending = pendingRemoval?.userId === m.user_id;
        if (isPending) {
          return (
            <span className="rc-rowactions">
              <span className="rc-cell-sub">Remove?</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={onConfirmRemove}
                disabled={pendingRemoval?.stage === 'removing'}
                data-testid={`confirm-remove-${m.user_id}`}
              >
                {pendingRemoval?.stage === 'removing' ? 'Removing…' : 'Confirm'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRemoval(null)}
                disabled={pendingRemoval?.stage === 'removing'}
              >
                Cancel
              </Button>
            </span>
          );
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPendingRemoval({ userId: m.user_id, stage: 'confirm' })}
            data-testid={`remove-member-${m.user_id}`}
          >
            Remove
          </Button>
        );
      },
    },
  ];

  return (
    <section className="rc-stack">
      <PageHeader
        title="Team members"
        description="Add or remove members of this team."
      />
      <div className="rc-rowactions">
        <Link to="/admin/teams" className="rc-link-action" data-testid="back-to-teams">
          ← Back to teams
        </Link>
        <Link
          to={`/admin/teams/${teamId}/clients`}
          className="rc-link-action"
          data-testid="manage-clients-link"
        >
          Manage clients →
        </Link>
      </div>
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading members…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <>
          <Card>
            <CardHead title="Add a member" />
            <div className="rc-formfoot">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Combobox
                  items={comboboxItems}
                  value={pickerValue}
                  onSelect={(item) => setPickerValue(item.value)}
                  placeholder="Select a user to add…"
                  emptyMessage="No remaining users."
                  ariaLabel="Add team member"
                  disabled={adding}
                  testId="add-member-combobox"
                />
              </div>
              <Button
                onClick={onAdd}
                disabled={!canAdd}
                data-testid="add-member-submit"
              >
                {adding ? 'Adding…' : 'Add member'}
              </Button>
            </div>
            {addError !== null && (
              <div className="rc-mt-8">
                <InlineAlert variant="error">
                  <strong>{addError.title}</strong>
                  {addError.detail !== undefined && (
                    <>
                      <br />
                      {addError.detail}
                    </>
                  )}
                </InlineAlert>
              </div>
            )}
          </Card>
          <Card flush>
            <DataTable
              columns={columns}
              rows={state.members}
              rowKey={(m) => m.id}
              emptyMessage="No members yet."
            />
          </Card>
        </>
      )}
    </section>
  );
}
