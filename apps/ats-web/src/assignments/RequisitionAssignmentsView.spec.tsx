import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { RequisitionAssignmentsView } from './RequisitionAssignmentsView';
import type { RequisitionAssignmentView } from './types';

const rows: RequisitionAssignmentView[] = [
  {
    id: 'ra1',
    tenant_id: 't',
    requisition_id: 'r-1',
    user_id: 'u-alice',
    assigned_at: '2026-01-01T00:00:00.000Z',
    assigned_by_id: null,
  },
];

// §5 D4c — picker source = the CLIENT-FILTERED assignable endpoint (the view
// fetches the req's company_id first); assigned-user names = the directory.
const assignableUsers: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
  { user_id: 'u-bob', display_name: 'Bob' },
];
const directoryNames: Record<string, string> = {
  'u-alice': 'Alice',
  'u-bob': 'Bob',
};

function renderView(opts?: {
  rowItems?: readonly RequisitionAssignmentView[];
  assignableUsers?: readonly AssignableUser[];
  names?: Record<string, string>;
  assignFn?: typeof import('./assignments-api').assignUserToRequisition;
  unassignFn?: typeof import('./assignments-api').unassignUserFromRequisition;
}) {
  const fetchAssignmentsFn = vi.fn(async () => ({
    items: opts?.rowItems ?? rows,
  }));
  const getRequisitionFn = vi.fn(async () => ({ company_id: 'c-acme' }));
  const fetchAssignableFn = vi.fn(
    async () => opts?.assignableUsers ?? assignableUsers,
  );
  const resolveNamesFn = vi.fn(async () => opts?.names ?? directoryNames);
  const assignFn = opts?.assignFn ?? vi.fn();
  const unassignFn = opts?.unassignFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <RequisitionAssignmentsView
            requisitionIdOverride="r-1"
            fetchAssignmentsFn={fetchAssignmentsFn}
            fetchAssignableFn={fetchAssignableFn}
            resolveNamesFn={resolveNamesFn}
            getRequisitionFn={getRequisitionFn}
            assignFn={assignFn}
            unassignFn={unassignFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
    fetchAssignmentsFn,
    fetchAssignableFn,
    getRequisitionFn,
    assignFn,
    unassignFn,
  };
}

describe('RequisitionAssignmentsView (F)', () => {
  it('renders assignments joined to roster', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(
      screen.getByTestId('req-assignment-row-u-alice'),
    ).toBeInTheDocument();
  });

  it('Combobox pre-filters to non-assigned users', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('assign-req-user-combobox'));
    expect(
      screen.getByTestId('assign-req-user-combobox-option-u-bob'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-req-user-combobox-option-u-alice'),
    ).not.toBeInTheDocument();
  });

  it('IDEMPOTENT assign (uniform ruling 1): duplicate POST resolves silently', async () => {
    const assignFn = vi.fn(async () => ({
      id: 'ra-existing',
      tenant_id: 't',
      requisition_id: 'r-1',
      user_id: 'u-bob',
      assigned_at: '2026-01-01T00:00:00.000Z',
      assigned_by_id: null,
    }));
    renderView({ assignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('assign-req-user-combobox'));
    fireEvent.click(screen.getByTestId('assign-req-user-combobox-option-u-bob'));
    fireEvent.click(screen.getByTestId('assign-req-user-submit'));
    await waitFor(() => expect(assignFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('IDEMPOTENT DELETE 404 (uniform ruling 1): treated as SUCCESS', async () => {
    const unassignFn = vi.fn(async () => {
      throw new ApiError(404, 'gone', 'NOT_FOUND', {});
    });
    const { fetchAssignmentsFn } = renderView({ unassignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('unassign-req-u-alice'));
    fireEvent.click(screen.getByTestId('confirm-unassign-req-u-alice'));
    await waitFor(() => expect(unassignFn).toHaveBeenCalled());
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('§5 D4c: client-filtered Combobox always renders — no 403→UUID fallback', async () => {
    const { fetchAssignableFn, getRequisitionFn } = renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    // The req's company_id is fetched and passed to the assignable endpoint.
    await waitFor(() => expect(getRequisitionFn).toHaveBeenCalledWith('r-1'));
    expect(fetchAssignableFn).toHaveBeenCalledWith('c-acme');
    expect(
      screen.getByTestId('assign-req-user-combobox'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-req-user-uuid-input'),
    ).not.toBeInTheDocument();
  });
});
