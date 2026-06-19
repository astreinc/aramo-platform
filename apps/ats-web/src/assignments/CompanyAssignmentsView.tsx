import { ApiError, Combobox, type ComboboxItem, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

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
import { probeUserRoster, type TenantUserView, type UserRosterState } from './roster';
import type { UserClientAssignmentRow } from './types';

// Company-assignments editor at /admin/companies/:companyId/assignments
// (ported to ats-web, FE Consolidation Directive 4; restyled to Confident
// Blue). Deep-link only — no Companies list in the admin nav (recruiter-app
// territory). Idempotency (uniform across the three editors): POST duplicate →
// silent success; DELETE 404 → success toast. Roster-403 fallback: the shared
// probeUserRoster() degrades the picker to a raw-UUID input.

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

  const columns: ReadonlyArray<TableColumn<UserClientAssignmentRow>> = [
    {
      key: 'user',
      header: 'User',
      render: (r) => {
        const u = rosterById.get(r.user_id);
        const name = u?.display_name ?? u?.email ?? r.user_id;
        const email = u?.email;
        return (
          <span data-testid={`assignment-row-${r.user_id}`}>
            <span>{name}</span>
            {email !== undefined && email !== name && (
              <span className="rc-cell-sub"> · {email}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'assigned',
      header: 'Assigned',
      render: (r) => new Date(r.assigned_at).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => {
        const isPending = pendingRemoval?.userId === r.user_id;
        if (isPending) {
          return (
            <span className="rc-rowactions">
              <span className="rc-cell-sub">Unassign?</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={onConfirmRemove}
                disabled={pendingRemoval?.stage === 'removing'}
                data-testid={`confirm-unassign-${r.user_id}`}
              >
                {pendingRemoval?.stage === 'removing' ? 'Unassigning…' : 'Confirm'}
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
            onClick={() => setPendingRemoval({ userId: r.user_id, stage: 'confirm' })}
            data-testid={`unassign-${r.user_id}`}
          >
            Unassign
          </Button>
        );
      },
    },
  ];

  return (
    <section className="rc-stack">
      <PageHeader
        title="Company assignments"
        description="Users assigned to this company."
      />
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading assignments…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && (
        <>
          <Card>
            <CardHead title="Assign a user" />
            <div className="rc-formfoot">
              {roster.state === 'ready' ? (
                <div style={{ flex: 1, minWidth: 0 }}>
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
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FormField
                    label={<label htmlFor="assign-user-uuid">User ID</label>}
                    helper="Roster unavailable to your role — paste the UUID."
                  >
                    <input
                      id="assign-user-uuid"
                      type="text"
                      className="rc-input"
                      value={uuidInput}
                      disabled={adding}
                      onChange={(ev) => setUuidInput(ev.target.value)}
                      data-testid="assign-user-uuid-input"
                    />
                  </FormField>
                </div>
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
              rows={state.rows}
              rowKey={(r) => r.id}
              emptyMessage="No users assigned to this company yet."
            />
          </Card>
        </>
      )}
    </section>
  );
}
