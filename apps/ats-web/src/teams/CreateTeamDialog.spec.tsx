import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { UserRosterState } from '../assignments/roster';

import { CreateTeamDialog } from './CreateTeamDialog';

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

function renderDialog(opts?: {
  roster?: UserRosterState;
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
        roster={opts?.roster ?? readyRoster}
        onCreated={onCreated}
        createFn={createFn}
      />
    </ToastProvider>,
  );
}

describe('CreateTeamDialog (S5c-2)', () => {
  it('ruling 5: renders name input + Combobox owner picker when roster is ready', () => {
    renderDialog();
    expect(screen.getByTestId('create-team-name-input')).toBeInTheDocument();
    expect(
      screen.getByTestId('create-team-owner-combobox'),
    ).toBeInTheDocument();
  });

  it('ruling 7: 403 fallback renders raw-UUID input for owner + helper copy', () => {
    renderDialog({ roster: { state: 'forbidden' } });
    expect(
      screen.getByTestId('create-team-owner-input').tagName,
    ).toBe('INPUT');
    expect(
      screen.getByText(/User roster isn.t available to your role/i),
    ).toBeInTheDocument();
  });

  it('Submit disabled until both name and owner present', () => {
    renderDialog({ roster: { state: 'forbidden' } });
    const submit = screen.getByTestId('create-team-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: 'Alpha' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('create-team-owner-input'), {
      target: { value: 'u-bob' },
    });
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
    renderDialog({
      roster: { state: 'forbidden' },
      createFn,
      onCreated,
    });
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: '  Alpha  ' },
    });
    fireEvent.change(screen.getByTestId('create-team-owner-input'), {
      target: { value: 'u-bob' },
    });
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
    renderDialog({ roster: { state: 'forbidden' }, createFn });
    fireEvent.change(screen.getByTestId('create-team-name-input'), {
      target: { value: 'Alpha' },
    });
    fireEvent.change(screen.getByTestId('create-team-owner-input'), {
      target: { value: 'u-bob' },
    });
    fireEvent.click(screen.getByTestId('create-team-submit'));
    await waitFor(() =>
      expect(
        screen.getByText(/A team named "Alpha" already exists/i),
      ).toBeInTheDocument(),
    );
  });
});
