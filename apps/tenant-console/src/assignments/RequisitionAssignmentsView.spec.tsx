import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toast';
import type { UserRosterState } from '../users/users-api';

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

const readyRoster: UserRosterState = {
  state: 'ready',
  users: [
    {
      user_id: 'u-alice',
      email: 'alice@a.test',
      display_name: 'Alice',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
    {
      user_id: 'u-bob',
      email: 'bob@a.test',
      display_name: 'Bob',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
  ],
};

function renderView(opts?: {
  rowItems?: readonly RequisitionAssignmentView[];
  roster?: UserRosterState;
  assignFn?: typeof import('./assignments-api').assignUserToRequisition;
  unassignFn?: typeof import('./assignments-api').unassignUserFromRequisition;
}) {
  const fetchAssignmentsFn = vi.fn(async () => ({
    items: opts?.rowItems ?? rows,
  }));
  const probeRosterFn = vi.fn(async () => opts?.roster ?? readyRoster);
  const assignFn = opts?.assignFn ?? vi.fn();
  const unassignFn = opts?.unassignFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <RequisitionAssignmentsView
            requisitionIdOverride="r-1"
            fetchAssignmentsFn={fetchAssignmentsFn}
            probeRosterFn={probeRosterFn}
            assignFn={assignFn}
            unassignFn={unassignFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
    fetchAssignmentsFn,
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

  it('ruling 5: 403 fallback renders raw-UUID input', async () => {
    renderView({ roster: { state: 'forbidden' } });
    await waitFor(() =>
      expect(
        screen.getByTestId('req-assignment-row-u-alice'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('assign-req-user-uuid-input'),
    ).toBeInTheDocument();
  });
});
