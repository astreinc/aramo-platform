import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@aramo/fe-foundation';

import { UsersListView } from './UsersListView';
import { ROLE_FIXTURE } from './roles.fixture';
import type { TenantUserView } from './types';

const activeUser: TenantUserView = {
  user_id: 'u-active',
  email: 'active@b.test',
  display_name: 'Active Person',
  is_active: true,
  invite_status: 'ACTIVE',
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

const disabledUser: TenantUserView = {
  user_id: 'u-disabled',
  email: 'disabled@b.test',
  display_name: 'Disabled Person',
  is_active: false,
  invite_status: 'ACTIVE',
  deactivated_at: '2026-01-01T00:00:00.000Z',
  site_id: null,
  role_keys: ['recruiter'],
};

// Invite-S3 — the pending-state fixtures.
const invitedUser: TenantUserView = {
  user_id: 'u-invited',
  email: 'invited@b.test',
  display_name: 'Invited Person',
  is_active: true,
  invite_status: 'INVITED',
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

const acceptedUser: TenantUserView = {
  user_id: 'u-accepted',
  email: 'accepted@b.test',
  display_name: 'Accepted Person',
  is_active: true,
  invite_status: 'ACCEPTED',
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

function renderView(opts?: {
  users?: readonly TenantUserView[];
  financials?: 'known-on' | 'known-off' | 'unknown';
  enableFn?: (userId: string) => Promise<{ membership_id: string }>;
  resendFn?: (
    userId: string,
  ) => Promise<{ sent: 'invitation' | 'confirmation' }>;
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
          rolesFn={async () => ROLE_FIXTURE}
          enableFn={opts?.enableFn}
          resendFn={opts?.resendFn}
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

  it('a disabled (INACTIVE) row shows Enable and NOT Disable (§3 matrix)', async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByText('Disabled Person')).toBeInTheDocument(),
    );
    // INACTIVE → Enable available, Disable absent.
    expect(
      screen.getByTestId(`enable-${disabledUser.user_id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`disable-${disabledUser.user_id}`),
    ).not.toBeInTheDocument();
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
      screen.getByText(/You can re-enable them later from this screen/i),
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

// Invite-S3 — the 5-state badge + state-dependent action cell.
describe('UsersListView — 5-state badge + actions (§2/§3)', () => {
  it('renders the right badge per displayed status', async () => {
    renderView({ users: [invitedUser, acceptedUser, activeUser, disabledUser] });
    await waitFor(() =>
      expect(screen.getByText('Invited Person')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId(`user-status-${invitedUser.user_id}`),
    ).toHaveTextContent(/^Invited$/);
    expect(
      screen.getByTestId(`user-status-${acceptedUser.user_id}`),
    ).toHaveTextContent(/^Accepted$/);
    expect(
      screen.getByTestId(`user-status-${activeUser.user_id}`),
    ).toHaveTextContent(/^Active$/);
    expect(
      screen.getByTestId(`user-status-${disabledUser.user_id}`),
    ).toHaveTextContent(/^Disabled$/);
  });

  it('INVITED row → Resend + Revoke (no Disable/Enable)', async () => {
    renderView({ users: [invitedUser] });
    await waitFor(() =>
      expect(screen.getByText('Invited Person')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId(`resend-${invitedUser.user_id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`revoke-${invitedUser.user_id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`disable-${invitedUser.user_id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`enable-${invitedUser.user_id}`),
    ).not.toBeInTheDocument();
  });

  it('ACTIVE row → Disable only (no Resend/Revoke/Enable)', async () => {
    renderView({ users: [activeUser] });
    await waitFor(() =>
      expect(screen.getByText('Active Person')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId(`disable-${activeUser.user_id}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`resend-${activeUser.user_id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`revoke-${activeUser.user_id}`),
    ).not.toBeInTheDocument();
  });

  it('Resend (INVITED) calls the endpoint and toasts an invitation', async () => {
    const resendFn = vi.fn(async () => ({ sent: 'invitation' as const }));
    renderView({ users: [invitedUser], resendFn });
    await waitFor(() =>
      expect(screen.getByText('Invited Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`resend-${invitedUser.user_id}`));
    await waitFor(() =>
      expect(resendFn).toHaveBeenCalledWith(invitedUser.user_id),
    );
    await waitFor(() =>
      expect(screen.getByText(/Invitation re-sent/i)).toBeInTheDocument(),
    );
  });

  it('Enable (INACTIVE) calls the endpoint and toasts', async () => {
    const enableFn = vi.fn(async () => ({ membership_id: 'm1' }));
    renderView({ users: [disabledUser], enableFn });
    await waitFor(() =>
      expect(screen.getByText('Disabled Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`enable-${disabledUser.user_id}`));
    await waitFor(() =>
      expect(enableFn).toHaveBeenCalledWith(disabledUser.user_id),
    );
    await waitFor(() =>
      expect(screen.getByText(/Enabled/i)).toBeInTheDocument(),
    );
  });

  it('Revoke (INVITED) opens the confirm dialog', async () => {
    renderView({ users: [invitedUser] });
    await waitFor(() =>
      expect(screen.getByText('Invited Person')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId(`revoke-${invitedUser.user_id}`));
    expect(
      screen.getByText(/Revoke this invitation\?/i),
    ).toBeInTheDocument();
  });
});
