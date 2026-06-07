import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toast';

import { OrgHierarchyView } from './OrgHierarchyView';
import type { ManagementEdgeRow, UserRosterState } from './types';

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

const readyRoster: UserRosterState = {
  state: 'ready',
  users: [
    {
      user_id: 'u-alice',
      email: 'alice@b.test',
      display_name: 'Alice',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
    {
      user_id: 'u-bob',
      email: 'bob@b.test',
      display_name: 'Bob',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
  ],
};

function renderView(opts?: {
  edges?: readonly ManagementEdgeRow[];
  roster?: UserRosterState;
  deleteFn?: (id: string) => Promise<void>;
}) {
  const fetchEdgesFn = vi.fn(async () => ({ items: opts?.edges ?? [] }));
  const probeFn = vi.fn(async () => opts?.roster ?? readyRoster);
  const deleteFn = opts?.deleteFn ?? vi.fn(async () => undefined);
  return {
    ...render(
      <ToastProvider>
        <OrgHierarchyView
          fetchEdgesFn={fetchEdgesFn}
          probeRosterFn={probeFn}
          deleteFn={deleteFn}
        />
      </ToastProvider>,
    ),
    fetchEdgesFn,
    probeFn,
    deleteFn,
  };
}

describe('OrgHierarchyView (S5c-1)', () => {
  it('renders the page header + the Add edge button', async () => {
    // Empty edges + empty roster -> no synthesized roots -> empty state.
    renderView({ edges: [], roster: { state: 'forbidden' } });
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
    renderView({ edges: [], roster: { state: 'forbidden' } });
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

  it('PICKER-SOURCE 403 fallback: the AddEdge Dialog renders raw UUID inputs', async () => {
    renderView({ edges: [], roster: { state: 'forbidden' } });
    await waitFor(() =>
      expect(
        screen.getByText(/no reporting relationships/i),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-add-edge'));
    expect(screen.getByTestId('add-edge-manager-input')).toBeInTheDocument();
  });

  it('inline-error on edges-fetch failure', async () => {
    const fetchEdgesFn = vi.fn(async () => {
      throw new ApiError(500, 'boom', 'INTERNAL', {});
    });
    const probeFn = vi.fn(async () => readyRoster);
    render(
      <ToastProvider>
        <OrgHierarchyView
          fetchEdgesFn={fetchEdgesFn}
          probeRosterFn={probeFn}
        />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('boom')).toBeInTheDocument(),
    );
  });
});
