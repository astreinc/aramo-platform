import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { TeamsListView } from './TeamsListView';
import type { TeamRow } from './types';

const teams: TeamRow[] = [
  {
    id: 't1',
    tenant_id: 'tenant',
    name: 'Alpha',
    owner_user_id: 'u-alice',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 't2',
    tenant_id: 'tenant',
    name: 'Beta',
    owner_user_id: 'u-bob',
    is_active: false,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];

const readyAssignable: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
];

const readyNames: Record<string, string> = {
  'u-alice': 'Alice',
};

function renderView(opts?: {
  teamItems?: readonly TeamRow[];
  assignable?: readonly AssignableUser[];
  names?: Record<string, string>;
}) {
  const fetchTeamsFn = vi.fn(async () => ({ items: opts?.teamItems ?? teams }));
  const fetchAssignableFn = vi.fn(
    async () => opts?.assignable ?? readyAssignable,
  );
  const resolveNamesFn = vi.fn(async () => opts?.names ?? readyNames);
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TeamsListView
          fetchTeamsFn={fetchTeamsFn}
          fetchAssignableFn={fetchAssignableFn}
          resolveNamesFn={resolveNamesFn}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('TeamsListView (S5c-2)', () => {
  it('renders the teams Table with name + owner + status + actions', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // Owner name resolved via the directory (Alice).
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    // Inactive team has the Inactive badge.
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('falls back to raw user_id for owner when the name-resolve misses', async () => {
    renderView({ names: {} });
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    // Owner column shows the raw user_id when the directory map is empty.
    expect(screen.getByText('u-alice')).toBeInTheDocument();
  });

  it('renders the empty state when there are no teams', async () => {
    renderView({ teamItems: [] });
    await waitFor(() =>
      expect(screen.getByText(/No teams yet/i)).toBeInTheDocument(),
    );
  });

  it('has a clickable team link per row pointing at /teams/:id', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const link = screen.getByTestId('team-link-t1') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/admin/teams/t1');
  });
});
