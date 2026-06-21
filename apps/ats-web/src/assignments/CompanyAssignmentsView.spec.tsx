import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

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

// §5 D4c — the picker source is the assignable endpoint (broad active roster,
// {user_id, display_name}); assigned-user names come from the directory.
const assignableUsers: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
  { user_id: 'u-bob', display_name: 'Bob' },
];
const directoryNames: Record<string, string> = {
  'u-alice': 'Alice',
  'u-bob': 'Bob',
};

function renderView(opts?: {
  rowItems?: readonly UserClientAssignmentRow[];
  assignableUsers?: readonly AssignableUser[];
  names?: Record<string, string>;
  assignFn?: typeof import('./assignments-api').assignUserToCompany;
  unassignFn?: typeof import('./assignments-api').unassignUserFromCompany;
  fetchFn?: (id: string) => Promise<{ items: readonly UserClientAssignmentRow[] }>;
}) {
  const fetchAssignmentsFn =
    opts?.fetchFn ?? vi.fn(async () => ({ items: opts?.rowItems ?? rows }));
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
          <CompanyAssignmentsView
            companyIdOverride="c-acme"
            fetchAssignmentsFn={fetchAssignmentsFn}
            fetchAssignableFn={fetchAssignableFn}
            resolveNamesFn={resolveNamesFn}
            assignFn={assignFn}
            unassignFn={unassignFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
    fetchAssignmentsFn,
    fetchAssignableFn,
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

  it('§5 D4c: the picker is always the Combobox — no 403→UUID fallback', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByTestId('assign-user-combobox')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-user-uuid-input'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Roster unavailable to your role/i),
    ).not.toBeInTheDocument();
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
