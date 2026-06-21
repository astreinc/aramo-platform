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
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
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

// Company-assignments editor at /admin/companies/:companyId/assignments
// (ported to ats-web, FE Consolidation Directive 4; restyled to Confident
// Blue). Deep-link only. Idempotency (uniform across the three editors): POST
// duplicate → silent success; DELETE 404 → success toast.
//
// §5 Auth-Hardening D4c — the two-source split. The PICKER (who to assign) →
// fetchAssignableUsers (the assignable endpoint; BROAD active roster — this
// view CREATES client mappings, so it must NOT client-self-filter). The
// assigned-user NAME display → resolveUserNames (the directory; resolves
// incl. departed users). The admin-gated 403→UUID fallback is GONE — every
// work-assigning role holds the assignable scope, so the picker always loads.

interface Props {
  companyIdOverride?: string;
  fetchAssignmentsFn?: (id: string) => Promise<{ items: readonly UserClientAssignmentRow[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
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

export function CompanyAssignmentsView({
  companyIdOverride,
  fetchAssignmentsFn,
  fetchAssignableFn,
  resolveNamesFn,
  assignFn,
  unassignFn,
}: Props = {}) {
  const params = useParams<{ companyId?: string }>();
  const companyId = companyIdOverride ?? params.companyId ?? '';

  const fetchAssignmentsFun = fetchAssignmentsFn ?? fetchCompanyAssignments;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;
  const assignFun = assignFn ?? assignUserToCompany;
  const unassignFun = unassignFn ?? unassignUserFromCompany;
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
        // Resolve assigned-user names from the directory (incl. departed).
        void resolveNamesFun(view.items.map((r) => r.user_id)).then((m) => {
          if (!cancelled) setNames(m);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = messageForFetchCompanyAssignments(err);
        setState({ status: 'error', message: msg.title });
      });
    // BROAD active roster (no company_id) — this view creates the mappings.
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
  }, [fetchAssignmentsFun, fetchAssignableFun, resolveNamesFun, companyId]);

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
      await assignFun({ companyId, body: { user_id: targetUserId } });
      toast.show('User assigned.');
      setPickerValue(null);
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

  const canAdd = !adding && pickerValue !== null;

  const columns: ReadonlyArray<TableColumn<UserClientAssignmentRow>> = [
    {
      key: 'user',
      header: 'User',
      render: (r) => {
        const name = names[r.user_id] ?? r.user_id;
        return (
          <span data-testid={`assignment-row-${r.user_id}`}>
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
