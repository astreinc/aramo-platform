import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { AddEdgeDialog } from './AddEdgeDialog';

const readyUsers: readonly AssignableUser[] = [
  { user_id: 'u-alice', display_name: 'Alice' },
  { user_id: 'u-bob', display_name: 'Bob' },
];

function renderDialog(opts?: {
  users?: readonly AssignableUser[];
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
        users={opts?.users ?? readyUsers}
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
