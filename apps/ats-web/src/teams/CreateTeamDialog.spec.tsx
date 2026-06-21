import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { CreateTeamDialog } from './CreateTeamDialog';

const readyUsers: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
  { user_id: 'u-bob', display_name: 'Bob' },
];

function renderDialog(opts?: {
  users?: readonly AssignableUser[];
  createFn?: typeof import('./teams-api').createTeam;
  onCreated?: () => void;
}) {
  const createFn = opts?.createFn ?? vi.fn();
  const onCreated = opts?.onCreated ?? vi.fn();
  return render(
    <ToastProvider>
      <CreateTeamDialog
        open={true}
        onOpenChange={() => undefined}
        users={opts?.users ?? readyUsers}
        onCreated={onCreated}
        createFn={createFn}
      />
    </ToastProvider>,
  );
}

describe('CreateTeamDialog (S5c-2)', () => {
  it('ruling 5: renders name input + Combobox owner picker', () => {
    renderDialog();
    expect(screen.getByTestId('create-team-name-input')).toBeInTheDocument();
    expect(
      screen.getByTestId('create-team-owner-combobox'),
    ).toBeInTheDocument();
  });

  it('Submit disabled until both name and owner present', () => {
    renderDialog();
    const submit = screen.getByTestId('create-team-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: 'Alpha' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('create-team-owner-combobox'));
    fireEvent.click(
      screen.getByTestId('create-team-owner-combobox-option-u-bob'),
    );
    expect(submit.disabled).toBe(false);
  });

  it('calls createFn with trimmed name + owner and refreshes', async () => {
    const createFn = vi.fn(async () => ({
      id: 't1',
      name: 'Alpha',
      owner_user_id: 'u-bob',
      is_active: true,
    }));
    const onCreated = vi.fn();
    renderDialog({ createFn, onCreated });
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: '  Alpha  ' },
    });
    fireEvent.click(screen.getByTestId('create-team-owner-combobox'));
    fireEvent.click(
      screen.getByTestId('create-team-owner-combobox-option-u-bob'),
    );
    fireEvent.click(screen.getByTestId('create-team-submit'));
    await waitFor(() => expect(createFn).toHaveBeenCalledTimes(1));
    expect(createFn).toHaveBeenCalledWith({
      name: 'Alpha',
      owner_user_id: 'u-bob',
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('ruling 6: duplicate-NAME surfaces the legible "team named X already exists" message', async () => {
    const createFn = vi.fn(async () => {
      throw new ApiError(
        400,
        'A team with this name already exists',
        'VALIDATION_ERROR',
        { name: 'Alpha', existing_team_id: 't-existing' },
      );
    });
    renderDialog({ createFn });
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: 'Alpha' },
    });
    fireEvent.click(screen.getByTestId('create-team-owner-combobox'));
    fireEvent.click(
      screen.getByTestId('create-team-owner-combobox-option-u-bob'),
    );
    fireEvent.click(screen.getByTestId('create-team-submit'));
    await waitFor(() =>
      expect(
        screen.getByText(/A team named "Alpha" already exists/i),
      ).toBeInTheDocument(),
    );
  });
});
