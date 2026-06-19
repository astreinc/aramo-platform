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
  assignUserToRequisition,
  fetchRequisitionAssignments,
  unassignUserFromRequisition,
} from './assignments-api';
import {
  messageForAssignRequisition,
  messageForFetchRequisitionAssignments,
  messageForUnassignRequisition,
  type ErrorMessage,
} from './error-messages';
import { probeUserRoster, type TenantUserView, type UserRosterState } from './roster';
import type { RequisitionAssignmentView } from './types';

// Requisition-assign editor at /admin/requisitions/:requisitionId/assignments
// (ported to ats-web, FE Consolidation Directive 4; restyled to Confident
// Blue). Mirrors CompanyAssignmentsView (user-picker over the roster); the
// parent is a requisition. Deep-link only.

interface Props {
  requisitionIdOverride?: string;
  fetchAssignmentsFn?: (id: string) => Promise<{ items: readonly RequisitionAssignmentView[] }>;
  probeRosterFn?: () => Promise<UserRosterState>;
  assignFn?: typeof assignUserToRequisition;
  unassignFn?: typeof unassignUserFromRequisition;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly RequisitionAssignmentView[] }
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

export function RequisitionAssignmentsView({
  requisitionIdOverride,
  fetchAssignmentsFn,
  probeRosterFn,
  assignFn,
  unassignFn,
}: Props = {}) {
  const params = useParams<{ requisitionId?: string }>();
  const requisitionId = requisitionIdOverride ?? params.requisitionId ?? '';

  const fetchAssignmentsFun = fetchAssignmentsFn ?? fetchRequisitionAssignments;
  const probeRoster = probeRosterFn ?? probeUserRoster;
  const assignFun = assignFn ?? assignUserToRequisition;
  const unassignFun = unassignFn ?? unassignUserFromRequisition;
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
    fetchAssignmentsFun(requisitionId)
      .then((view) => setState({ status: 'ready', rows: view.items }))
      .catch((err: unknown) => {
        const msg = messageForFetchRequisitionAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchAssignmentsFun(requisitionId)
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', rows: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchRequisitionAssignments(err);
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
  }, [fetchAssignmentsFun, probeRoster, requisitionId]);

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
      await assignFun({ requisitionId, body: { user_id: targetUserId } });
      toast.show('User assigned.');
      setPickerValue(null);
      setUuidInput('');
      refresh();
    } catch (err: unknown) {
      setAddError(messageForAssignRequisition(err));
    } finally {
      setAdding(false);
    }
  };

  const onConfirmRemove = async () => {
    if (pendingRemoval === null) return;
    const userId = pendingRemoval.userId;
    setPendingRemoval({ userId, stage: 'removing' });
    try {
      await unassignFun({ requisitionId, userId });
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
      toast.show(messageForUnassignRequisition(err).title);
      setPendingRemoval(null);
    }
  };

  const canAdd =
    !adding &&
    ((roster.state === 'ready' && pickerValue !== null) ||
      (roster.state !== 'ready' && uuidInput.trim().length > 0));

  const columns: ReadonlyArray<TableColumn<RequisitionAssignmentView>> = [
    {
      key: 'user',
      header: 'User',
      render: (r) => {
        const u = rosterById.get(r.user_id);
        const name = u?.display_name ?? u?.email ?? r.user_id;
        const email = u?.email;
        return (
          <span data-testid={`req-assignment-row-${r.user_id}`}>
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
                data-testid={`confirm-unassign-req-${r.user_id}`}
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
            data-testid={`unassign-req-${r.user_id}`}
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
        title="Requisition assignments"
        description="Users assigned to this requisition."
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
                    ariaLabel="Assign a user to this requisition"
                    disabled={adding}
                    testId="assign-req-user-combobox"
                  />
                </div>
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FormField
                    label={<label htmlFor="assign-req-user-uuid">User ID</label>}
                    helper="Roster unavailable to your role — paste the UUID."
                  >
                    <input
                      id="assign-req-user-uuid"
                      type="text"
                      className="rc-input"
                      value={uuidInput}
                      disabled={adding}
                      onChange={(ev) => setUuidInput(ev.target.value)}
                      data-testid="assign-req-user-uuid-input"
                    />
                  </FormField>
                </div>
              )}
              <Button
                onClick={onAdd}
                disabled={!canAdd}
                data-testid="assign-req-user-submit"
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
              emptyMessage="No users assigned to this requisition yet."
            />
          </Card>
        </>
      )}
    </section>
  );
}
