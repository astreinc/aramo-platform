import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { OrgHierarchyView } from './OrgHierarchyView';
import type { ManagementEdgeRow } from './types';

function makeEdge(
  id: string,
  manager: string,
  report: string,
): ManagementEdgeRow {
  return {
    id,
    tenant_id: 't1',
    manager_user_id: manager,
    report_user_id: report,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by_id: null,
  };
}

const readyAssignable: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
  { user_id: 'u-bob', display_name: 'Bob' },
];

const readyNames: Record<string, string> = {
  'u-alice': 'Alice',
  'u-bob': 'Bob',
};

function renderView(opts?: {
  edges?: readonly ManagementEdgeRow[];
  assignable?: readonly AssignableUser[];
  names?: Record<string, string>;
  deleteFn?: (id: string) => Promise<void>;
}) {
  const fetchEdgesFn = vi.fn(async () => ({ items: opts?.edges ?? [] }));
  const fetchAssignableFn = vi.fn(
    async () => opts?.assignable ?? readyAssignable,
  );
  const resolveNamesFn = vi.fn(async () => opts?.names ?? readyNames);
  const deleteFn = opts?.deleteFn ?? vi.fn(async () => undefined);
  return {
    ...render(
      <ToastProvider>
        <OrgHierarchyView
          fetchEdgesFn={fetchEdgesFn}
          fetchAssignableFn={fetchAssignableFn}
          resolveNamesFn={resolveNamesFn}
          deleteFn={deleteFn}
        />
      </ToastProvider>,
    ),
    fetchEdgesFn,
    fetchAssignableFn,
    resolveNamesFn,
    deleteFn,
  };
}

describe('OrgHierarchyView (S5c-1)', () => {
  it('renders the page header + the Add edge button', async () => {
    // Empty edges + empty roster -> no synthesized roots -> empty state.
    renderView({ edges: [], assignable: [], names: {} });
    expect(screen.getByText('Organisation hierarchy')).toBeInTheDocument();
    expect(screen.getByTestId('open-add-edge')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText(/no reporting relationships/i),
      ).toBeInTheDocument(),
    );
  });

  it('renders the synthesized tree from the edges and roster', async () => {
    renderView({ edges: [makeEdge('e1', 'u-alice', 'u-bob')] });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('opens the AddEdgeDialog when the button is clicked', async () => {
    renderView({ edges: [], assignable: [], names: {} });
    await waitFor(() =>
      expect(
        screen.getByText(/no reporting relationships/i),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-add-edge'));
    expect(screen.getByTestId('add-edge-form')).toBeInTheDocument();
  });

  it('clicking a non-root Remove invokes deleteFn with the edge_id and refreshes', async () => {
    const deleteFn = vi.fn(async () => undefined);
    const { fetchEdgesFn } = renderView({
      edges: [makeEdge('e1', 'u-alice', 'u-bob')],
      deleteFn,
    });
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('tree-remove-e1'));
    await waitFor(() => expect(deleteFn).toHaveBeenCalledWith('e1'));
    // Refresh fetched again (initial + post-remove).
    await waitFor(() =>
      expect(fetchEdgesFn).toHaveBeenCalledTimes(2),
    );
  });

  it('idempotent DELETE 404 is treated as success (the edge was already gone)', async () => {
    const deleteFn = vi.fn(async () => {
      throw new ApiError(404, 'gone', 'NOT_FOUND', {});
    });
    const { fetchEdgesFn } = renderView({
      edges: [makeEdge('e1', 'u-alice', 'u-bob')],
      deleteFn,
    });
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('tree-remove-e1'));
    // The view still refreshes (no thrown error).
    await waitFor(() =>
      expect(fetchEdgesFn).toHaveBeenCalledTimes(2),
    );
  });

  it('inline-error on edges-fetch failure', async () => {
    const fetchEdgesFn = vi.fn(async () => {
      throw new ApiError(500, 'boom', 'INTERNAL', {});
    });
    const fetchAssignableFn = vi.fn(async () => readyAssignable);
    const resolveNamesFn = vi.fn(async () => readyNames);
    render(
      <ToastProvider>
        <OrgHierarchyView
          fetchEdgesFn={fetchEdgesFn}
          fetchAssignableFn={fetchAssignableFn}
          resolveNamesFn={resolveNamesFn}
        />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('boom')).toBeInTheDocument(),
    );
  });
});
