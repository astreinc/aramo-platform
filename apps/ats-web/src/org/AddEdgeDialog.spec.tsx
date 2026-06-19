import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import { AddEdgeDialog } from './AddEdgeDialog';
import type { UserRosterState } from './types';

const readyRoster: UserRosterState = {
  state: 'ready',
  users: [
    {
      user_id: 'u-alice',
      email: 'alice@b.test',
      display_name: 'Alice',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
    {
      user_id: 'u-bob',
      email: 'bob@b.test',
      display_name: 'Bob',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: [],
    },
  ],
};

const forbiddenRoster: UserRosterState = { state: 'forbidden' };

function renderDialog(opts?: {
  roster?: UserRosterState;
  addFn?: typeof import('./edges-api').addManagementEdge;
  onAdded?: () => void;
}) {
  const addFn = opts?.addFn ?? vi.fn();
  const onAdded = opts?.onAdded ?? vi.fn();
  return render(
    <ToastProvider>
      <AddEdgeDialog
        open={true}
        onOpenChange={() => undefined}
        roster={opts?.roster ?? readyRoster}
        onAdded={onAdded}
        addFn={addFn}
      />
    </ToastProvider>,
  );
}

describe('AddEdgeDialog (S5c-1)', () => {
  it('ROSTER ready: renders native selects (NOT a Combobox — ruling 1)', () => {
    renderDialog();
    // Ruling 1: a hand-styled native <select>.
    expect(screen.getByTestId('add-edge-manager-select').tagName).toBe(
      'SELECT',
    );
    expect(screen.getByTestId('add-edge-report-select').tagName).toBe(
      'SELECT',
    );
  });

  it('PICKER-SOURCE 403 FALLBACK (ruling 6): renders raw UUID inputs + the helper copy', () => {
    renderDialog({ roster: forbiddenRoster });
    expect(screen.getByTestId('add-edge-manager-input').tagName).toBe(
      'INPUT',
    );
    expect(screen.getByTestId('add-edge-report-input').tagName).toBe('INPUT');
    expect(
      screen.getByText(/User roster isn.t available to your role/i),
    ).toBeInTheDocument();
  });

  it('Save button is disabled until both fields are populated', () => {
    renderDialog();
    const submit = screen.getByTestId('add-edge-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('add-edge-manager-select'), {
      target: { value: 'u-alice' },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('add-edge-report-select'), {
      target: { value: 'u-bob' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('calls addFn with the chosen ids and refreshes', async () => {
    const addFn = vi.fn(async () => ({
      id: 'e1',
      manager_user_id: 'u-alice',
      report_user_id: 'u-bob',
    }));
    const onAdded = vi.fn();
    renderDialog({ addFn, onAdded });

    fireEvent.change(screen.getByTestId('add-edge-manager-select'), {
      target: { value: 'u-alice' },
    });
    fireEvent.change(screen.getByTestId('add-edge-report-select'), {
      target: { value: 'u-bob' },
    });
    fireEvent.click(screen.getByTestId('add-edge-submit'));

    await waitFor(() => expect(addFn).toHaveBeenCalledTimes(1));
    expect(addFn).toHaveBeenCalledWith({
      manager_user_id: 'u-alice',
      report_user_id: 'u-bob',
    });
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });

  it('surfaces self_loop rejection legibly', async () => {
    const addFn = vi.fn(async () => {
      throw new ApiError(409, 'self', 'MANAGEMENT_CYCLE_REJECTED', {
        reason: 'self_loop',
      });
    });
    renderDialog({ addFn });
    fireEvent.change(screen.getByTestId('add-edge-manager-select'), {
      target: { value: 'u-alice' },
    });
    fireEvent.change(screen.getByTestId('add-edge-report-select'), {
      target: { value: 'u-alice' },
    });
    fireEvent.click(screen.getByTestId('add-edge-submit'));

    await waitFor(() =>
      expect(
        screen.getByText(/can.t manage themselves/i),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces cycle rejection legibly', async () => {
    const addFn = vi.fn(async () => {
      throw new ApiError(409, 'cycle', 'MANAGEMENT_CYCLE_REJECTED', {
        reason: 'cycle',
      });
    });
    renderDialog({ addFn });
    fireEvent.change(screen.getByTestId('add-edge-manager-select'), {
      target: { value: 'u-bob' },
    });
    fireEvent.change(screen.getByTestId('add-edge-report-select'), {
      target: { value: 'u-alice' },
    });
    fireEvent.click(screen.getByTestId('add-edge-submit'));

    await waitFor(() =>
      expect(screen.getByText(/reporting cycle/i)).toBeInTheDocument(),
    );
  });

  it('DUPLICATE = SILENT SUCCESS (ruling 4): a duplicate POST resolves normally — no error', async () => {
    // The BE returns 201 with the existing edge body; the FE treats
    // this as success — no special error message.
    const addFn = vi.fn(async () => ({
      id: 'e-existing',
      manager_user_id: 'u-alice',
      report_user_id: 'u-bob',
    }));
    const onAdded = vi.fn();
    renderDialog({ addFn, onAdded });

    fireEvent.change(screen.getByTestId('add-edge-manager-select'), {
      target: { value: 'u-alice' },
    });
    fireEvent.change(screen.getByTestId('add-edge-report-select'), {
      target: { value: 'u-bob' },
    });
    fireEvent.click(screen.getByTestId('add-edge-submit'));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    // No InlineAlert error rendered — the alert role is reserved for
    // errors; if any error renders, the role="alert" element appears.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
