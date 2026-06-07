import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { UserRosterState } from '../users/users-api';

import { CompanyAssignmentsView } from './CompanyAssignmentsView';
import type { UserClientAssignmentRow } from './types';

const rows: UserClientAssignmentRow[] = [
  {
    id: 'a1',
    tenant_id: 't',
    user_id: 'u-alice',
    company_id: 'c-acme',
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
  rowItems?: readonly UserClientAssignmentRow[];
  roster?: UserRosterState;
  assignFn?: typeof import('./assignments-api').assignUserToCompany;
  unassignFn?: typeof import('./assignments-api').unassignUserFromCompany;
  fetchFn?: (id: string) => Promise<{ items: readonly UserClientAssignmentRow[] }>;
}) {
  const fetchAssignmentsFn =
    opts?.fetchFn ?? vi.fn(async () => ({ items: opts?.rowItems ?? rows }));
  const probeRosterFn = vi.fn(async () => opts?.roster ?? readyRoster);
  const assignFn = opts?.assignFn ?? vi.fn();
  const unassignFn = opts?.unassignFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <CompanyAssignmentsView
            companyIdOverride="c-acme"
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

describe('CompanyAssignmentsView (D)', () => {
  it('renders the assignment list joined to the roster', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(
      screen.getByTestId('assignment-row-u-alice'),
    ).toBeInTheDocument();
  });

  it('Combobox is pre-filtered to NON-ASSIGNED users (Alice excluded; Bob shown)', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('assign-user-combobox'));
    expect(
      screen.getByTestId('assign-user-combobox-option-u-bob'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-user-combobox-option-u-alice'),
    ).not.toBeInTheDocument();
  });

  it('assign: select + Add → POST', async () => {
    const assignFn = vi.fn(async () => ({
      id: 'a2',
      user_id: 'u-bob',
      company_id: 'c-acme',
    }));
    const { fetchAssignmentsFn } = renderView({ assignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('assign-user-combobox'));
    fireEvent.click(screen.getByTestId('assign-user-combobox-option-u-bob'));
    fireEvent.click(screen.getByTestId('assign-user-submit'));
    await waitFor(() =>
      expect(assignFn).toHaveBeenCalledWith({
        companyId: 'c-acme',
        body: { user_id: 'u-bob' },
      }),
    );
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT assign (uniform ruling 1): duplicate POST resolves silently — no role="alert"', async () => {
    const assignFn = vi.fn(async () => ({
      id: 'a-existing',
      user_id: 'u-bob',
      company_id: 'c-acme',
    }));
    renderView({ assignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('assign-user-combobox'));
    fireEvent.click(screen.getByTestId('assign-user-combobox-option-u-bob'));
    fireEvent.click(screen.getByTestId('assign-user-submit'));
    await waitFor(() => expect(assignFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('unassign: inline confirm → DELETE; refresh', async () => {
    const unassignFn = vi.fn(async () => undefined);
    const { fetchAssignmentsFn } = renderView({ unassignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('unassign-u-alice'));
    expect(screen.getByText('Unassign?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-unassign-u-alice'));
    await waitFor(() =>
      expect(unassignFn).toHaveBeenCalledWith({
        companyId: 'c-acme',
        userId: 'u-alice',
      }),
    );
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT DELETE 404 (uniform ruling 1): treated as SUCCESS — toast + refresh', async () => {
    const unassignFn = vi.fn(async () => {
      throw new ApiError(404, 'gone', 'NOT_FOUND', {});
    });
    const { fetchAssignmentsFn } = renderView({ unassignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('unassign-u-alice'));
    fireEvent.click(screen.getByTestId('confirm-unassign-u-alice'));
    await waitFor(() => expect(unassignFn).toHaveBeenCalled());
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('ruling 5: 403 fallback renders raw-UUID input', async () => {
    renderView({ roster: { state: 'forbidden' } });
    await waitFor(() =>
      expect(
        screen.getByTestId('assignment-row-u-alice'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('assign-user-uuid-input')).toBeInTheDocument();
    expect(
      screen.getByText(/Roster unavailable to your role/i),
    ).toBeInTheDocument();
  });

  it('cross-tenant 404 on fetch surfaces "company isn’t in your tenant"', async () => {
    const fetchFn = vi.fn(async () => {
      throw new ApiError(404, 'nope', 'NOT_FOUND', {});
    });
    renderView({ fetchFn });
    await waitFor(() =>
      expect(
        screen.getByText(/company isn.t in your tenant/i),
      ).toBeInTheDocument(),
    );
  });
});
