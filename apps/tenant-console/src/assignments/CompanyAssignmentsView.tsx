import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError } from '../api/client';
import { Button } from '../components/Button';
import { Combobox, type ComboboxItem } from '../components/Combobox';
import { FormField } from '../components/FormField';
import { InlineAlert } from '../components/InlineAlert';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import type { TenantUserView } from '../users/types';
import {
  probeUserRoster,
  type UserRosterState,
} from '../users/users-api';

import {
  assignUserToCompany,
  fetchCompanyAssignments,
  unassignUserFromCompany,
} from './assignments-api';
import {
  messageForAssignUser,
  messageForFetchCompanyAssignments,
  messageForUnassignUser,
  type ErrorMessage,
} from './error-messages';
import type { UserClientAssignmentRow } from './types';

// Settings S5c-3 — Company-assignments editor at /companies/:companyId/
// assignments (PL-94 §2 ruling 4: deep-link only — no Companies list in
// the tenant-admin nav; recruiter-app territory).
//
// Idempotency (PL-94 §2 ruling 1; uniform across D + E + F):
//   - POST duplicate → SILENT SUCCESS (BE returns existing row).
//   - DELETE 404 → SUCCESS toast at FE (intent satisfied).
//
// Roster-403 fallback (ruling 5): probeUserRoster() (shared) → on 403
// the add-user picker degrades to a raw-UUID input + helper copy.

interface Props {
  companyIdOverride?: string;
  fetchAssignmentsFn?: (id: string) => Promise<{ items: readonly UserClientAssignmentRow[] }>;
  probeRosterFn?: () => Promise<UserRosterState>;
  assignFn?: typeof assignUserToCompany;
  unassignFn?: typeof unassignUserFromCompany;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly UserClientAssignmentRow[] }
  | { status: 'error'; message: string };

interface PendingRemoval {
  readonly userId: string;
  readonly stage: 'confirm' | 'removing';
}

function rosterToItems(
  roster: UserRosterState,
  assignedUserIds: ReadonlySet<string>,
): ReadonlyArray<ComboboxItem> {
  if (roster.state !== 'ready') return [];
  return [...roster.users]
    .filter((u) => !assignedUserIds.has(u.user_id))
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

export function CompanyAssignmentsView({
  companyIdOverride,
  fetchAssignmentsFn,
  probeRosterFn,
  assignFn,
  unassignFn,
}: Props = {}) {
  const params = useParams<{ companyId?: string }>();
  const companyId = companyIdOverride ?? params.companyId ?? '';

  const fetchAssignmentsFun = fetchAssignmentsFn ?? fetchCompanyAssignments;
  const probeRoster = probeRosterFn ?? probeUserRoster;
  const assignFun = assignFn ?? assignUserToCompany;
  const unassignFun = unassignFn ?? unassignUserFromCompany;
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
    fetchAssignmentsFun(companyId)
      .then((view) => setState({ status: 'ready', rows: view.items }))
      .catch((err: unknown) => {
        const msg = messageForFetchCompanyAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchAssignmentsFun(companyId)
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', rows: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchCompanyAssignments(err);
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
  }, [fetchAssignmentsFun, probeRoster, companyId]);

  const rosterById = useMemo(() => {
    const m = new Map<string, TenantUserView>();
    if (roster.state === 'ready') {
      for (const u of roster.users) m.set(u.user_id, u);
    }
    return m;
  }, [roster]);

  const assignedUserIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') {
      for (const r of state.rows) s.add(r.user_id);
    }
    return s;
  }, [state]);

  const comboboxItems = useMemo(
    () => rosterToItems(roster, assignedUserIds),
    [roster, assignedUserIds],
  );

  const onAdd = async () => {
    const targetUserId =
      roster.state === 'ready' ? pickerValue : uuidInput.trim();
    if (targetUserId === null || targetUserId.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await assignFun({ companyId, body: { user_id: targetUserId } });
      toast.show('User assigned.');
      setPickerValue(null);
      setUuidInput('');
      refresh();
    } catch (err: unknown) {
      setAddError(messageForAssignUser(err));
    } finally {
      setAdding(false);
    }
  };

  const onConfirmRemove = async () => {
    if (pendingRemoval === null) return;
    const userId = pendingRemoval.userId;
    setPendingRemoval({ userId, stage: 'removing' });
    try {
      await unassignFun({ companyId, userId });
      toast.show('User unassigned.');
      setPendingRemoval(null);
      refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        toast.show('User already unassigned.');
        setPendingRemoval(null);
        refresh();
        return;
      }
      toast.show(messageForUnassignUser(err).title);
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
        title="Company assignments"
        description="Users assigned to this company."
      />
      {state.status === 'loading' && (
        <p className="tc-helper">Loading assignments…</p>
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
                  placeholder="Select a user to assign…"
                  emptyMessage="No remaining users."
                  ariaLabel="Assign a user to this company"
                  disabled={adding}
                  testId="assign-user-combobox"
                />
              </div>
            ) : (
              <FormField
                label={<label htmlFor="assign-user-uuid">User ID</label>}
                helper="Roster unavailable to your role — paste the UUID."
              >
                <input
                  id="assign-user-uuid"
                  type="text"
                  className="tc-input"
                  value={uuidInput}
                  disabled={adding}
                  onChange={(ev) => setUuidInput(ev.target.value)}
                  data-testid="assign-user-uuid-input"
                />
              </FormField>
            )}
            <Button
              onClick={onAdd}
              disabled={!canAdd}
              data-testid="assign-user-submit"
            >
              {adding ? 'Assigning…' : 'Assign user'}
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
          {state.rows.length === 0 ? (
            <div className="tc-tree-empty">
              <p className="tc-helper">No users assigned to this company yet.</p>
            </div>
          ) : (
            <ul
              className="tc-member-list"
              aria-label="Company-assigned users"
            >
              {state.rows.map((r) => {
                const u = rosterById.get(r.user_id);
                const name = u?.display_name ?? u?.email ?? r.user_id;
                const email = u?.email;
                const assigned = new Date(r.assigned_at).toLocaleDateString();
                const isPending = pendingRemoval?.userId === r.user_id;
                return (
                  <li
                    key={r.id}
                    className="tc-member-list__row"
                    data-testid={`assignment-row-${r.user_id}`}
                  >
                    <div>
                      <div className="tc-member-list__name">{name}</div>
                      {email !== undefined && email !== name && (
                        <div className="tc-member-list__email">{email}</div>
                      )}
                    </div>
                    <span className="tc-member-list__added">
                      Assigned {assigned}
                    </span>
                    <div className="tc-member-list__actions">
                      {isPending ? (
                        <>
                          <span className="tc-helper">Unassign?</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={onConfirmRemove}
                            disabled={pendingRemoval?.stage === 'removing'}
                            data-testid={`confirm-unassign-${r.user_id}`}
                          >
                            {pendingRemoval?.stage === 'removing'
                              ? 'Unassigning…'
                              : 'Confirm'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingRemoval(null)}
                            disabled={pendingRemoval?.stage === 'removing'}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPendingRemoval({ userId: r.user_id, stage: 'confirm' })
                          }
                          data-testid={`unassign-${r.user_id}`}
                        >
                          Unassign
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
