import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { CompanyAssignmentsView, type UserEnrich } from './CompanyAssignmentsView';
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
// {user_id, display_name}); assigned-user names come from the directory; email +
// role come from the admin roster (fetchTenantUsers) via the injected enrichFn.
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
  enrich?: Record<string, UserEnrich>;
  canManage?: boolean;
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
  const enrichFn = vi.fn(async () => opts?.enrich ?? {});
  const assignFn = opts?.assignFn ?? vi.fn();
  const unassignFn = opts?.unassignFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <CompanyAssignmentsView
            companyIdOverride="c-acme"
            canManage={opts?.canManage ?? true}
            fetchAssignmentsFn={fetchAssignmentsFn}
            fetchAssignableFn={fetchAssignableFn}
            resolveNamesFn={resolveNamesFn}
            enrichFn={enrichFn}
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

// Open the "+ Add member" panel and focus the search box so the picker opens.
function openPicker() {
  fireEvent.click(screen.getByTestId('team-add-member'));
  fireEvent.click(screen.getByTestId('assign-user-search'));
}

describe('CompanyAssignmentsView (Account team)', () => {
  it('renders the team table joined to the roster', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByTestId('assignment-row-u-alice')).toBeInTheDocument();
  });

  it('wires email + role into the member row (fetchTenantUsers enrichment)', async () => {
    renderView({
      enrich: { 'u-alice': { email: 'alice@astre.com', role: 'Account Manager' } },
    });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('alice@astre.com')).toBeInTheDocument();
    expect(screen.getByText('Account Manager')).toBeInTheDocument();
  });

  it('the add picker is pre-filtered to NON-ASSIGNED users (Alice excluded; Bob shown)', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    openPicker();
    expect(screen.getByTestId('assign-user-option-u-bob')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-user-option-u-alice'),
    ).not.toBeInTheDocument();
  });

  it('the add picker filters by name/email as the query changes', async () => {
    renderView({
      assignableUsers: [
        { user_id: 'u-bob', display_name: 'Bob' },
        { user_id: 'u-carol', display_name: 'Carol' },
      ],
      names: { 'u-bob': 'Bob', 'u-carol': 'Carol' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('team-add-member')).toBeInTheDocument(),
    );
    openPicker();
    fireEvent.change(screen.getByTestId('assign-user-search'), {
      target: { value: 'car' },
    });
    expect(screen.getByTestId('assign-user-option-u-carol')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assign-user-option-u-bob'),
    ).not.toBeInTheDocument();
  });

  it('assign: pick + Add to team → POST + refresh', async () => {
    const assignFn = vi.fn(async () => ({
      id: 'a2',
      user_id: 'u-bob',
      company_id: 'c-acme',
    }));
    const { fetchAssignmentsFn } = renderView({ assignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    openPicker();
    fireEvent.click(screen.getByTestId('assign-user-option-u-bob'));
    fireEvent.click(screen.getByTestId('assign-user-submit'));
    await waitFor(() =>
      expect(assignFn).toHaveBeenCalledWith({
        companyId: 'c-acme',
        body: { user_id: 'u-bob' },
      }),
    );
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT assign: duplicate POST resolves silently — no role="alert"', async () => {
    const assignFn = vi.fn(async () => ({
      id: 'a-existing',
      user_id: 'u-bob',
      company_id: 'c-acme',
    }));
    renderView({ assignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    openPicker();
    fireEvent.click(screen.getByTestId('assign-user-option-u-bob'));
    fireEvent.click(screen.getByTestId('assign-user-submit'));
    await waitFor(() => expect(assignFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('remove: inline confirm → DELETE; refresh', async () => {
    const unassignFn = vi.fn(async () => undefined);
    const { fetchAssignmentsFn } = renderView({ unassignFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('unassign-u-alice'));
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-unassign-u-alice'));
    await waitFor(() =>
      expect(unassignFn).toHaveBeenCalledWith({
        companyId: 'c-acme',
        userId: 'u-alice',
      }),
    );
    await waitFor(() => expect(fetchAssignmentsFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT DELETE 404: treated as SUCCESS — refresh', async () => {
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

  it('without canManage: no Add / Remove affordance, view-only note shown', async () => {
    renderView({ canManage: false });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByTestId('team-add-member')).toBeNull();
    expect(screen.queryByTestId('unassign-u-alice')).toBeNull();
    expect(
      screen.getByText(/Ask an account manager to change assignments/i),
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
