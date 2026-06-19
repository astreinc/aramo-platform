import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { UserRosterState } from '../assignments/roster';

import { TeamMembersView } from './TeamMembersView';
import type { TeamMembershipRow } from './types';

const members: TeamMembershipRow[] = [
  {
    id: 'm1',
    tenant_id: 'tenant',
    team_id: 't1',
    user_id: 'u-alice',
    added_at: '2026-01-01T00:00:00.000Z',
    added_by_id: 'u-actor',
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
    {
      user_id: 'u-carol',
      email: 'carol@a.test',
      display_name: 'Carol',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
  ],
};

function renderView(opts?: {
  memberItems?: readonly TeamMembershipRow[];
  roster?: UserRosterState;
  addMemberFn?: typeof import('./teams-api').addMember;
  removeMemberFn?: typeof import('./teams-api').removeMember;
  fetchMembersFn?: (teamId: string) => Promise<{ items: readonly TeamMembershipRow[] }>;
}) {
  const fetchMembersFn =
    opts?.fetchMembersFn ?? vi.fn(async () => ({ items: opts?.memberItems ?? members }));
  const probeRosterFn = vi.fn(async () => opts?.roster ?? readyRoster);
  const addMemberFn = opts?.addMemberFn ?? vi.fn();
  const removeMemberFn = opts?.removeMemberFn ?? vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <ToastProvider>
          <TeamMembersView
            teamIdOverride="t1"
            fetchMembersFn={fetchMembersFn}
            probeRosterFn={probeRosterFn}
            addMemberFn={addMemberFn}
            removeMemberFn={removeMemberFn}
          />
        </ToastProvider>
      </MemoryRouter>,
    ),
    fetchMembersFn,
    addMemberFn,
    removeMemberFn,
  };
}

describe('TeamMembersView (S5c-2)', () => {
  it('renders members + the Combobox add (ruling 3 sub-route)', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByTestId('add-member-combobox')).toBeInTheDocument();
    expect(screen.getByTestId('member-row-u-alice')).toBeInTheDocument();
  });

  it('Combobox is pre-filtered to NON-MEMBERS (Alice excluded; Bob + Carol shown)', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-member-combobox'));
    // The combobox shows non-members only.
    expect(screen.getByTestId('add-member-combobox-option-u-bob')).toBeInTheDocument();
    expect(screen.getByTestId('add-member-combobox-option-u-carol')).toBeInTheDocument();
    expect(
      screen.queryByTestId('add-member-combobox-option-u-alice'),
    ).not.toBeInTheDocument();
  });

  it('add-member: select + click Add → POST /members', async () => {
    const addMemberFn = vi.fn(async () => ({
      id: 'm2',
      team_id: 't1',
      user_id: 'u-bob',
    }));
    const { fetchMembersFn } = renderView({ addMemberFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-member-combobox'));
    fireEvent.click(screen.getByTestId('add-member-combobox-option-u-bob'));
    fireEvent.click(screen.getByTestId('add-member-submit'));
    await waitFor(() =>
      expect(addMemberFn).toHaveBeenCalledWith({
        teamId: 't1',
        body: { user_id: 'u-bob' },
      }),
    );
    // The list refreshes (initial + after-add).
    await waitFor(() => expect(fetchMembersFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT add (ruling 6): a duplicate add resolves SILENTLY — no role="alert"', async () => {
    // The BE is idempotent on duplicate (team, user): returns 201 with
    // the existing row. The FE refreshes the list with no error UI.
    const addMemberFn = vi.fn(async () => ({
      id: 'm-existing',
      team_id: 't1',
      user_id: 'u-bob',
    }));
    renderView({ addMemberFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-member-combobox'));
    fireEvent.click(screen.getByTestId('add-member-combobox-option-u-bob'));
    fireEvent.click(screen.getByTestId('add-member-submit'));
    await waitFor(() => expect(addMemberFn).toHaveBeenCalledTimes(1));
    // No error alert rendered.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('remove: inline confirm → DELETE on confirm; refresh', async () => {
    const removeMemberFn = vi.fn(async () => undefined);
    const { fetchMembersFn } = renderView({ removeMemberFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remove-member-u-alice'));
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-remove-u-alice'));
    await waitFor(() =>
      expect(removeMemberFn).toHaveBeenCalledWith({
        teamId: 't1',
        userId: 'u-alice',
      }),
    );
    await waitFor(() => expect(fetchMembersFn).toHaveBeenCalledTimes(2));
  });

  it('IDEMPOTENT DELETE 404 (ruling 6): treated as SUCCESS — toast + refresh', async () => {
    const removeMemberFn = vi.fn(async () => {
      throw new ApiError(404, 'gone', 'NOT_FOUND', {});
    });
    const { fetchMembersFn } = renderView({ removeMemberFn });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remove-member-u-alice'));
    fireEvent.click(screen.getByTestId('confirm-remove-u-alice'));
    await waitFor(() => expect(removeMemberFn).toHaveBeenCalled());
    // The list refreshes (the intent is satisfied — the member is gone).
    await waitFor(() => expect(fetchMembersFn).toHaveBeenCalledTimes(2));
  });

  it('ruling 7: 403 fallback renders raw-UUID input for add-member', async () => {
    renderView({ roster: { state: 'forbidden' } });
    // Wait for the members-list to settle (the row keyed on user_id
    // still renders; the roster-join just falls back to the raw id).
    await waitFor(() =>
      expect(screen.getByTestId('member-row-u-alice')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('add-member-uuid-input')).toBeInTheDocument();
    expect(
      screen.getByText(/Roster unavailable to your role/i),
    ).toBeInTheDocument();
  });

  it('per-tenant isolation: 404 on members fetch surfaces "isn’t in your tenant"', async () => {
    const fetchMembersFn = vi.fn(async () => {
      throw new ApiError(404, 'nope', 'NOT_FOUND', {});
    });
    renderView({ fetchMembersFn });
    await waitFor(() =>
      expect(
        screen.getByText(/This team isn.t in your tenant/i),
      ).toBeInTheDocument(),
    );
  });
});
