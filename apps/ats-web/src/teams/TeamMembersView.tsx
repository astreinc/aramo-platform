import { ApiError, Combobox, type ComboboxItem, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { probeUserRoster, type TenantUserView, type UserRosterState } from '../assignments/roster';
import {
  Button,
  Card,
  CardHead,
  DataTable,
  FormField,
  InlineAlert,
  PageHeader,
  type TableColumn,
} from '../ui';

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
  probeRosterFn?: () => Promise<UserRosterState>;
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
  roster: UserRosterState,
  memberUserIds: ReadonlySet<string>,
): ReadonlyArray<ComboboxItem> {
  if (roster.state !== 'ready') return [];
  return [...roster.users]
    .filter((u) => !memberUserIds.has(u.user_id))
    .sort((a, b) => {
      const an = a.display_name ?? a.email;
      const bn = b.display_name ?? b.email;
      return an.localeCompare(bn);
    })
    .map((u) => ({
      value: u.user_id,
      label: u.display_name ?? u.email,
      description: u.display_name !== null ? u.email : undefined,
    }));
}

export function TeamMembersView({
  teamIdOverride,
  fetchMembersFn,
  probeRosterFn,
  addMemberFn,
  removeMemberFn,
}: Props = {}) {
  const params = useParams<{ teamId?: string }>();
  const teamId = teamIdOverride ?? params.teamId ?? '';

  const fetchMembersFun = fetchMembersFn ?? fetchTeamMembers;
  const probeRoster = probeRosterFn ?? probeUserRoster;
  const addMemberFun = addMemberFn ?? addMember;
  const removeMemberFun = removeMemberFn ?? removeMember;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [roster, setRoster] = useState<UserRosterState>({ state: 'forbidden' });
  const [pickerValue, setPickerValue] = useState<string | null>(null);
  const [uuidInput, setUuidInput] = useState('');
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
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchTeamMembersError(err);
        setState({ status: 'error', message: msg.title });
      });
    probeRoster()
      .then((next) => {
        if (cancelled) return;
        setRoster(next);
      })
      .catch(() => {
        if (cancelled) return;
        setRoster({ state: 'forbidden' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchMembersFun, probeRoster, teamId]);

  const rosterById = useMemo(() => {
    const m = new Map<string, TenantUserView>();
    if (roster.state === 'ready') {
      for (const u of roster.users) m.set(u.user_id, u);
    }
    return m;
  }, [roster]);

  const memberUserIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') {
      for (const m of state.members) s.add(m.user_id);
    }
    return s;
  }, [state]);

  const comboboxItems = useMemo(
    () => rosterToItems(roster, memberUserIds),
    [roster, memberUserIds],
  );

  const onAdd = async () => {
    const targetUserId =
      roster.state === 'ready' ? pickerValue : uuidInput.trim();
    if (targetUserId === null || targetUserId.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await addMemberFun({ teamId, body: { user_id: targetUserId } });
      toast.show('Member added.');
      setPickerValue(null);
      setUuidInput('');
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

  const canAdd =
    !adding &&
    ((roster.state === 'ready' && pickerValue !== null) ||
      (roster.state !== 'ready' && uuidInput.trim().length > 0));

  const columns: ReadonlyArray<TableColumn<TeamMembershipRow>> = [
    {
      key: 'member',
      header: 'Member',
      render: (m) => {
        const u = rosterById.get(m.user_id);
        const name = u?.display_name ?? u?.email ?? m.user_id;
        const email = u?.email;
        return (
          <span data-testid={`member-row-${m.user_id}`}>
            <span>{name}</span>
            {email !== undefined && email !== name && (
              <span className="rc-cell-sub"> · {email}</span>
            )}
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
              {roster.state === 'ready' ? (
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
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FormField
                    label={<label htmlFor="add-member-uuid">User ID</label>}
                    helper="Roster unavailable to your role — paste the UUID."
                  >
                    <input
                      id="add-member-uuid"
                      type="text"
                      className="rc-input"
                      value={uuidInput}
                      disabled={adding}
                      onChange={(ev) => setUuidInput(ev.target.value)}
                      data-testid="add-member-uuid-input"
                    />
                  </FormField>
                </div>
              )}
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
