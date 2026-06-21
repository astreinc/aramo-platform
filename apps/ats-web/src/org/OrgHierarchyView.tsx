import { ApiError, useToast } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import { Button, Card, InlineAlert, PageHeader } from '../ui';
import {
  fetchAssignableUsers,
  resolveUserNames,
  type AssignableUser,
} from '../users/users-api';

import { AddEdgeDialog } from './AddEdgeDialog';
import { Tree } from './Tree';
import { deleteManagementEdge, fetchManagementEdges } from './edges-api';
import { synthesizeTree } from './tree-synthesis';
import type { ManagementEdgeRow, OrgUser } from './types';

// OrgHierarchyView at /admin/org (ported to ats-web, FE Consolidation Directive
// 5). §5 D4c — the two-source split: the AddEdge PICKER → fetchAssignableUsers
// (active roster — who you can wire into an edge); the TREE NAMES → the
// directory (resolveUserNames; incl. departed managers, so the org chart still
// renders a left employee's name). No 403→UUID fallback.

interface Props {
  fetchEdgesFn?: () => Promise<{ items: readonly ManagementEdgeRow[] }>;
  fetchAssignableFn?: (companyId?: string) => Promise<readonly AssignableUser[]>;
  resolveNamesFn?: (userIds?: readonly string[]) => Promise<Record<string, string>>;
  deleteFn?: (edgeId: string) => Promise<void>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; edges: readonly ManagementEdgeRow[] }
  | { status: 'error'; message: string };

export function OrgHierarchyView({
  fetchEdgesFn,
  fetchAssignableFn,
  resolveNamesFn,
  deleteFn,
}: Props = {}) {
  const fetchEdges = fetchEdgesFn ?? fetchManagementEdges;
  const fetchAssignableFun = fetchAssignableFn ?? fetchAssignableUsers;
  const resolveNamesFun = resolveNamesFn ?? resolveUserNames;
  const del = deleteFn ?? deleteManagementEdge;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pickerUsers, setPickerUsers] = useState<readonly AssignableUser[]>([]);
  const [treeUsers, setTreeUsers] = useState<readonly OrgUser[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const refresh = () => {
    setState({ status: 'loading' });
    fetchEdges()
      .then((view) => setState({ status: 'ready', edges: view.items }))
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to load org hierarchy.';
        setState({ status: 'error', message });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchEdges()
      .then((view) => {
        if (cancelled) return;
        setState({ status: 'ready', edges: view.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load org hierarchy.';
        setState({ status: 'error', message });
      });
    // PICKER source — active roster for the AddEdge selects.
    void fetchAssignableFun()
      .then((users) => {
        if (!cancelled) setPickerUsers(users);
      })
      .catch(() => {
        if (!cancelled) setPickerUsers([]);
      });
    // TREE NAME source — the directory (incl. departed managers). Build the
    // OrgUser[] the synthesizer needs (labels + lone-user roots) from the map.
    void resolveNamesFun()
      .then((map) => {
        if (cancelled) return;
        setTreeUsers(
          Object.entries(map).map(([user_id, display_name]) => ({
            user_id,
            display_name,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setTreeUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchEdges, fetchAssignableFun, resolveNamesFun]);

  const onRemoveEdge = async (edgeId: string) => {
    setRemoving(true);
    try {
      await del(edgeId);
      toast.show('Edge removed.');
      refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        toast.show('Edge already removed.');
        refresh();
        return;
      }
      toast.show(err instanceof Error ? err.message : 'Failed to remove edge.');
    } finally {
      setRemoving(false);
    }
  };

  const synthResult =
    state.status === 'ready'
      ? synthesizeTree({ edges: state.edges, users: treeUsers })
      : null;

  return (
    <section className="rc-stack">
      <PageHeader
        title="Organisation hierarchy"
        description="Manage who reports to whom across your tenant."
      />
      <div className="rc-formfoot">
        <span className="rc-muted-line">
          {state.status === 'ready'
            ? `${state.edges.length} edge${state.edges.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button onClick={() => setAddOpen(true)} data-testid="open-add-edge">
          Add edge
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="rc-muted-line">Loading hierarchy…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && synthResult !== null && (
        <Card flush>
          <div className="rc-treewrap">
            <Tree
              roots={synthResult.roots}
              onRemoveEdge={onRemoveEdge}
              removing={removing}
            />
          </div>
        </Card>
      )}
      <AddEdgeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        users={pickerUsers}
        onAdded={() => refresh()}
      />
    </section>
  );
}
