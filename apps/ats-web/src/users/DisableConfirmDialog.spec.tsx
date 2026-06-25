import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import { DisableConfirmDialog } from './DisableConfirmDialog';
import type { TenantUserView } from './types';

const fakeUser: TenantUserView = {
  user_id: 'u1',
  email: 'a@b.test',
  display_name: 'A Person',
  is_active: true,
  invite_status: 'ACTIVE',
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

function renderDialog(opts?: {
  disableFn?: typeof import('./users-api').disableTenantUser;
  onDisabled?: () => void;
}) {
  const onDisabled = opts?.onDisabled ?? vi.fn();
  const disableFn = opts?.disableFn ?? vi.fn();
  return render(
    <ToastProvider>
      <DisableConfirmDialog
        user={fakeUser}
        onOpenChange={() => undefined}
        onDisabled={onDisabled}
        disableFn={disableFn}
      />
    </ToastProvider>,
  );
}

describe('DisableConfirmDialog', () => {
  it('renders the user name and the reversible-disable copy (Invite-S3: Enable now exists)', () => {
    renderDialog();
    expect(screen.getByText(/A Person.*lose access/i)).toBeInTheDocument();
    expect(
      screen.getByText(/You can re-enable them later from this screen/i),
    ).toBeInTheDocument();
  });

  it('calls disableFn with userId and a null reason when the field is blank', async () => {
    const disableFn = vi.fn(async () => ({
      membership_id: 'm1',
      changed: true,
      already_disabled: false,
    }));
    renderDialog({ disableFn });
    fireEvent.click(screen.getByTestId('disable-confirm'));
    await waitFor(() => expect(disableFn).toHaveBeenCalledTimes(1));
    expect(disableFn).toHaveBeenCalledWith({
      userId: 'u1',
      reason: null,
    });
  });

  it('passes a trimmed reason when one is entered', async () => {
    const disableFn = vi.fn(async () => ({
      membership_id: 'm1',
      changed: true,
      already_disabled: false,
    }));
    renderDialog({ disableFn });
    fireEvent.change(screen.getByLabelText(/Reason \(optional\)/i), {
      target: { value: '  left the team  ' },
    });
    fireEvent.click(screen.getByTestId('disable-confirm'));
    await waitFor(() =>
      expect(disableFn).toHaveBeenCalledWith({
        userId: 'u1',
        reason: 'left the team',
      }),
    );
  });

  it('treats an idempotent already-disabled response as success (no error)', async () => {
    const disableFn = vi.fn(async () => ({
      membership_id: 'm1',
      changed: false,
      already_disabled: true,
    }));
    const onDisabled = vi.fn();
    renderDialog({ disableFn, onDisabled });
    fireEvent.click(screen.getByTestId('disable-confirm'));
    await waitFor(() => expect(onDisabled).toHaveBeenCalledTimes(1));
  });

  it('surfaces a per-tenant 404 with the right copy', async () => {
    const disableFn = vi.fn(async () => {
      throw new ApiError(404, 'nope', 'NOT_FOUND', {});
    });
    renderDialog({ disableFn });
    fireEvent.click(screen.getByTestId('disable-confirm'));
    await waitFor(() =>
      expect(
        screen.getByText(/not part of your tenant/i),
      ).toBeInTheDocument(),
    );
  });
});
