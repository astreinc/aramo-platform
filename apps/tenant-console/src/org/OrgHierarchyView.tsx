import { useEffect, useState } from 'react';
import { ApiError } from '@aramo/fe-foundation';
import { Button } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { PageHeader } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import { AddEdgeDialog } from './AddEdgeDialog';
import { Tree } from './Tree';
import {
  deleteManagementEdge,
  fetchManagementEdges,
  probeUserRoster,
} from './edges-api';
import { synthesizeTree } from './tree-synthesis';
import type {
  ManagementEdgeRow,
  UserRosterState,
} from './types';

// Settings S5c-1 — OrgHierarchyView.
//
// /org — the org-hierarchy editor. Gated `org:manage` (the route guard
// in App.tsx); the picker source (`GET /v1/tenant/users`) is gated
// `tenant:admin:user-manage` — try-read with 403 fallback (PL-94 §2
// ruling 6).
//
// Two parallel fetches on mount: GET /v1/management/edges + the user
// roster probe. The Tree synthesizes from both; on edges-load failure
// the view shows an inline error; on user-roster 403 the AddEdge
// Dialog falls back to raw-UUID inputs.

interface Props {
  fetchEdgesFn?: () => Promise<{ items: readonly ManagementEdgeRow[] }>;
  probeRosterFn?: () => Promise<UserRosterState>;
  deleteFn?: (edgeId: string) => Promise<void>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; edges: readonly ManagementEdgeRow[] }
  | { status: 'error'; message: string };

export function OrgHierarchyView({
  fetchEdgesFn,
  probeRosterFn,
  deleteFn,
}: Props = {}) {
  const fetchEdges = fetchEdgesFn ?? fetchManagementEdges;
  const probeRoster = probeRosterFn ?? probeUserRoster;
  const del = deleteFn ?? deleteManagementEdge;
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [roster, setRoster] = useState<UserRosterState>({ state: 'forbidden' });
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
    probeRoster()
      .then((next) => {
        if (cancelled) return;
        setRoster(next);
      })
      .catch(() => {
        // A non-403 probe failure: fall back to forbidden silently. The
        // AddEdge Dialog renders the UUID fallback; users with valid
        // IDs can still operate. The BE rejection is the floor.
        if (cancelled) return;
        setRoster({ state: 'forbidden' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchEdges, probeRoster]);

  const onRemoveEdge = async (edgeId: string) => {
    setRemoving(true);
    try {
      await del(edgeId);
      toast.show('Edge removed.');
      refresh();
    } catch (err: unknown) {
      // 404 = idempotent success (the edge is already gone).
      if (err instanceof ApiError && err.status === 404) {
        toast.show('Edge already removed.');
        refresh();
        return;
      }
      toast.show(
        err instanceof Error
          ? err.message
          : 'Failed to remove edge.',
      );
    } finally {
      setRemoving(false);
    }
  };

  const synthResult =
    state.status === 'ready'
      ? synthesizeTree({
          edges: state.edges,
          users: roster.state === 'ready' ? roster.users : [],
        })
      : null;

  return (
    <section>
      <PageHeader
        title="Organisation hierarchy"
        description="Manage who reports to whom across your tenant."
      />
      <div className="tc-page-actions">
        <span className="tc-helper">
          {state.status === 'ready'
            ? `${state.edges.length} edge${state.edges.length === 1 ? '' : 's'}`
            : ''}
        </span>
        <Button onClick={() => setAddOpen(true)} data-testid="open-add-edge">
          Add edge
        </Button>
      </div>
      {state.status === 'loading' && (
        <p className="tc-helper">Loading hierarchy…</p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">{state.message}</InlineAlert>
      )}
      {state.status === 'ready' && synthResult !== null && (
        <Tree
          roots={synthResult.roots}
          onRemoveEdge={onRemoveEdge}
          removing={removing}
        />
      )}
      <AddEdgeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        roster={roster}
        onAdded={() => refresh()}
      />
    </section>
  );
}
