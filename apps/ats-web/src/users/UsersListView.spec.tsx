import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { UsersListView } from './UsersListView';
import type { TenantUserView } from './types';

const activeUser: TenantUserView = {
  user_id: 'u-active',
  email: 'active@b.test',
  display_name: 'Active Person',
  is_active: true,
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

const disabledUser: TenantUserView = {
  user_id: 'u-disabled',
  email: 'disabled@b.test',
  display_name: 'Disabled Person',
  is_active: false,
  deactivated_at: '2026-01-01T00:00:00.000Z',
  site_id: null,
  role_keys: ['recruiter'],
};

function renderView(opts?: {
  users?: readonly TenantUserView[];
  financials?: 'known-on' | 'known-off' | 'unknown';
}) {
  const items = opts?.users ?? [activeUser, disabledUser];
  const probeFn = vi.fn(async () =>
    opts?.financials === 'known-on'
      ? ({ state: 'known' as const, enabled: true })
      : opts?.financials === 'known-off'
        ? ({ state: 'known' as const, enabled: false })
        : ({ state: 'unknown' as const }),
  );
  const fetchUsersFn = vi.fn(async () => ({ items }));
  return {
    ...render(
      <ToastProvider>
        <UsersListView
          fetchUsersFn={fetchUsersFn}
          probeFinancialsFn={probeFn}
        />
      </ToastProvider>,
    ),
    probeFn,
    fetchUsersFn,
  };
}

describe('UsersListView', () => {
  it('renders the roster as a Table with name/email/status/roles/actions', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    expect(screen.getByText('active@b.test')).toBeInTheDocument();
    expect(screen.getByText('Disabled Person')).toBeInTheDocument();
    // Both status badges rendered.
    expect(
      screen.getByTestId(`user-status-${activeUser.user_id}`),
    ).toHaveTextContent(/^Active$/);
    expect(
      screen.getByTestId(`user-status-${disabledUser.user_id}`),
    ).toHaveTextContent(/^Disabled$/);
  });

  it('a disabled user renders distinctly (muted row + Disabled badge)', async () => {
    const { container } = renderView();
    await waitFor(() =>
      expect(screen.getByText('Disabled Person')).toBeInTheDocument(),
    );
    // DataTable (the ats-web Confident-Blue table) marks a muted row with the
    // `rc-table__row--muted` class (the frozen Table used a data-muted attr).
    const mutedRows = container.querySelectorAll('tr.rc-table__row--muted');
    expect(mutedRows.length).toBe(1);
  });

  it('disable button is disabled on already-disabled rows', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Disabled Person')).toBeInTheDocument(),
    );
    const disableBtn = screen.getByTestId(
      `disable-${disabledUser.user_id}`,
    ) as HTMLButtonElement;
    expect(disableBtn.disabled).toBe(true);
  });

  it('opens the InviteDialog when "Invite user" is clicked', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-invite'));
    expect(screen.getByLabelText(/^Email$/i)).toBeInTheDocument();
  });

  it('opens the RoleAssignEditor when "Edit roles" is clicked', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`edit-roles-${activeUser.user_id}`));
    expect(
      screen.getByText(/Adjust the role-set for Active Person/i),
    ).toBeInTheDocument();
  });

  it('opens the DisableConfirmDialog when "Disable" is clicked', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`disable-${activeUser.user_id}`));
    expect(
      screen.getByText(/Re-enabling isn.t yet available from this screen/i),
    ).toBeInTheDocument();
  });

  it('renders the empty-state message when no users exist', async () => {
    renderView({ users: [] });
    await waitFor(() =>
      expect(
        screen.getByText(/No users yet/i),
      ).toBeInTheDocument(),
    );
  });

  it('runs the financials probe in parallel and threads the state into Dialogs', async () => {
    const { probeFn } = renderView({ financials: 'known-off' });
    await waitFor(() => expect(probeFn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    // Open the editor — auditor_with_financials should be proactively
    // disabled because the probe returned known-off.
    fireEvent.click(screen.getByTestId(`edit-roles-${activeUser.user_id}`));
    const auditor = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(auditor.disabled).toBe(true);
  });
});
