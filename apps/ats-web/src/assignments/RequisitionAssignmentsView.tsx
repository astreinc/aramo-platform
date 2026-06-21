import { ApiError, Combobox, type ComboboxItem, useToast } from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  Button,
  Card,
  CardHead,
  DataTable,
  InlineAlert,
  PageHeader,
  type TableColumn,
} from '../ui';
import { getRequisition } from '../requisitions/requisitions-api';
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

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
import type { RequisitionAssignmentView } from './types';

// Requisition-assign editor at /admin/requisitions/:requisitionId/assignments
// (ported to ats-web, FE Consolidation Directive 4; restyled to Confident
// Blue). Deep-link only.
//
// §5 Auth-Hardening D4c — the two-source split, CLIENT-FILTERED. The PICKER →
// fetchAssignableUsers(req.company_id): the requisition has a client, so the
// roster is narrowed to users MAPPED TO THAT CLIENT holding a req-carrying role
// (we fetch the req to get its company_id). The assigned-user NAME display →
// resolveUserNames (the directory; incl. departed). The 403→UUID fallback is GONE.

interface Props {
  requisitionIdOverride?: string;
  fetchAssignmentsFn?: (id: string) => Promise<{ items: readonly RequisitionAssignmentView[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
  getRequisitionFn?: (id: string) => Promise<{ company_id: string }>;
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
  users: readonly AssignableUser[],
  assignedUserIds: ReadonlySet<string>,
): ReadonlyArray<ComboboxItem> {
  return [...users]
    .filter((u) => !assignedUserIds.has(u.user_id))
    .sort((a, b) =>
      (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id),
    )
    .map((u) => ({ value: u.user_id, label: u.display_name ?? u.user_id }));
}

export function RequisitionAssignmentsView({
  requisitionIdOverride,
  fetchAssignmentsFn,
  fetchAssignableFn,
  resolveNamesFn,
  getRequisitionFn,
  assignFn,
  unassignFn,
}: Props = {}) {
  const params = useParams<{ requisitionId?: string }>();
  const requisitionId = requisitionIdOverride ?? params.requisitionId ?? '';

  const fetchAssignmentsFun = fetchAssignmentsFn ?? fetchRequisitionAssignments;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;
  const getRequisitionFun = getRequisitionFn ?? getRequisition;
  const assignFun = assignFn ?? assignUserToRequisition;
  const unassignFun = unassignFn ?? unassignUserFromRequisition;
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
        void resolveNamesFun(view.items.map((r) => r.user_id)).then((m) => {
          if (!cancelled) setNames(m);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchRequisitionAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
    // CLIENT-FILTERED roster: fetch the req's company_id, then the assignable
    // roster narrowed to that client + req-carrying roles.
    void getRequisitionFun(requisitionId)
      .then((req) => fetchAssignableFun(req.company_id))
      .then((users) => {
        if (!cancelled) setPickerUsers(users);
      })
      .catch(() => {
        if (!cancelled) setPickerUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAssignmentsFun, fetchAssignableFun, resolveNamesFun, getRequisitionFun, requisitionId]);

  const assignedUserIds = useMemo(() => {
    const s = new Set<string>();
    if (state.status === 'ready') {
      for (const r of state.rows) s.add(r.user_id);
    }
    return s;
  }, [state]);

  const comboboxItems = useMemo(
    () => rosterToItems(pickerUsers, assignedUserIds),
    [pickerUsers, assignedUserIds],
  );

  const onAdd = async () => {
    const targetUserId = pickerValue;
    if (targetUserId === null || targetUserId.length === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      await assignFun({ requisitionId, body: { user_id: targetUserId } });
      toast.show('User assigned.');
      setPickerValue(null);
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

  const canAdd = !adding && pickerValue !== null;

  const columns: ReadonlyArray<TableColumn<RequisitionAssignmentView>> = [
    {
      key: 'user',
      header: 'User',
      render: (r) => {
        const name = names[r.user_id] ?? r.user_id;
        return (
          <span data-testid={`req-assignment-row-${r.user_id}`}>
            <span>{name}</span>
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
