import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';
import { Button } from '@aramo/fe-foundation';
import { Combobox, type ComboboxItem } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { PageHeader } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import type { TenantUserView } from '../users/types';
import {
  probeUserRoster,
  type UserRosterState,
} from '../users/users-api';

import {
  messageForAddMemberError,
  messageForFetchTeamMembersError,
  messageForRemoveMemberError,
  type ErrorMessage,
} from './error-messages';
import {
  addMember,
  fetchTeamMembers,
  removeMember,
} from './teams-api';
import type { TeamMembershipRow } from './types';

// Settings S5c-2 — TeamMembersView at /teams/:teamId.
//
// PL-94 §2 ruling 3 — the sub-route for the members editor.
//
// PL-94 §2 ruling 5/6 — Combobox-add (non-members pre-filtered at the
// CONSUMER; the Combobox stays generic); idempotency mirrored:
//   - add duplicate → SILENT SUCCESS (BE returns 201 with existing
//     row; the FE refreshes the list, no error UI)
//   - DELETE 404 → SILENT SUCCESS ("Member already removed" toast)
//
// PL-94 §2 ruling 7 — roster-403 fallback. The member-add Combobox
// degrades to a raw-UUID input + helper copy. The member-list rows
// still render — they show raw user_id when the roster join is
// unavailable.

interface Props {
  // Test seam: bypasses useParams when supplied.
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

  const onRequestRemove = (userId: string) => {
    setPendingRemoval({ userId, stage: 'confirm' });
  };

  const onCancelRemove = () => {
    setPendingRemoval(null);
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
      // PL-94 §2 ruling 6 — DELETE 404 is idempotent success.
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

  return (
    <section>
      <PageHeader
        title="Team members"
        description="Add or remove members of this team."
      />
      <div className="tc-page-actions">
        <Link to="/teams" className="tc-helper" data-testid="back-to-teams">
          ← Back to teams
        </Link>
        {/* Settings S5c-3 — sibling sub-route to the team-clients editor. */}
        <Link
          to={`/teams/${teamId}/clients`}
          className="tc-link"
          data-testid="manage-clients-link"
        >
          Manage clients →
        </Link>
      </div>
      {state.status === 'loading' && (
        <p className="tc-helper">Loading members…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <>
          <div className="tc-add-member">
            {roster.state === 'ready' ? (
              <div className="tc-add-member__picker">
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
              <FormField
                label={<label htmlFor="add-member-uuid">User ID</label>}
                helper="Roster unavailable to your role — paste the UUID."
              >
                <input
                  id="add-member-uuid"
                  type="text"
                  className="tc-input"
                  value={uuidInput}
                  disabled={adding}
                  onChange={(ev) => setUuidInput(ev.target.value)}
                  data-testid="add-member-uuid-input"
                />
              </FormField>
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
            <InlineAlert variant="error">
              <strong>{addError.title}</strong>
              {addError.detail !== undefined && (
                <>
                  <br />
                  {addError.detail}
                </>
              )}
            </InlineAlert>
          )}
          {state.members.length === 0 ? (
            <div className="tc-tree-empty">
              <p className="tc-helper">No members yet.</p>
            </div>
          ) : (
            <ul className="tc-member-list" aria-label="Team members">
              {state.members.map((m) => {
                const u = rosterById.get(m.user_id);
                const name = u?.display_name ?? u?.email ?? m.user_id;
                const email = u?.email;
                const added = new Date(m.added_at).toLocaleDateString();
                const isPending = pendingRemoval?.userId === m.user_id;
                return (
                  <li
                    key={m.id}
                    className="tc-member-list__row"
                    data-testid={`member-row-${m.user_id}`}
                  >
                    <div>
                      <div className="tc-member-list__name">{name}</div>
                      {email !== undefined && email !== name && (
                        <div className="tc-member-list__email">{email}</div>
                      )}
                    </div>
                    <span className="tc-member-list__added">Added {added}</span>
                    <div className="tc-member-list__actions">
                      {isPending ? (
                        <>
                          <span className="tc-helper">Remove?</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={onConfirmRemove}
                            disabled={pendingRemoval?.stage === 'removing'}
                            data-testid={`confirm-remove-${m.user_id}`}
                          >
                            {pendingRemoval?.stage === 'removing'
                              ? 'Removing…'
                              : 'Confirm'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={onCancelRemove}
                            disabled={pendingRemoval?.stage === 'removing'}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRequestRemove(m.user_id)}
                          data-testid={`remove-member-${m.user_id}`}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
