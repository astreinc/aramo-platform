import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toast';

import { RoleAssignEditor } from './RoleAssignEditor';
import type { TenantUserView } from './types';

const baseUser: TenantUserView = {
  user_id: 'u1',
  email: 'a@b.test',
  display_name: 'A Person',
  is_active: true,
  deactivated_at: null,
  site_id: null,
  role_keys: ['recruiter'],
};

function renderEditor(opts?: {
  assignFn?: typeof import('./users-api').assignTenantUserRoles;
  onSaved?: () => void;
  financials?: 'known-on' | 'known-off' | 'unknown';
  user?: TenantUserView;
}) {
  const assignFn = opts?.assignFn ?? vi.fn();
  const onSaved = opts?.onSaved ?? vi.fn();
  const financialsToggle =
    opts?.financials === 'known-on'
      ? ({ state: 'known' as const, enabled: true })
      : opts?.financials === 'known-off'
        ? ({ state: 'known' as const, enabled: false })
        : ({ state: 'unknown' as const });
  return render(
    <ToastProvider>
      <RoleAssignEditor
        user={opts?.user ?? baseUser}
        onOpenChange={() => undefined}
        onSaved={onSaved}
        financialsToggle={financialsToggle}
        assignFn={assignFn}
      />
    </ToastProvider>,
  );
}

describe('RoleAssignEditor', () => {
  it('seeds the picker with the user’s current role_keys', () => {
    renderEditor();
    const recruiter = screen.getByLabelText(
      /^Recruiter/,
    ) as HTMLInputElement;
    expect(recruiter.checked).toBe(true);
  });

  it('keeps Save disabled until the picker diverges (the idempotency floor)', () => {
    renderEditor();
    const save = screen.getByTestId('role-assign-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('shows the before/after diff when the selection diverges', () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText(/^Finance/));
    const diff = screen.getByTestId('role-assign-diff');
    expect(diff).toBeInTheDocument();
    expect(screen.getByText('Adding')).toBeInTheDocument();
    // "Finance" appears in the picker as a label too — scope the
    // assertion to the diff block itself.
    expect(diff.textContent ?? '').toMatch(/Finance/);
  });

  it('calls assignFn with sorted role_keys and refreshes on success', async () => {
    const assignFn = vi.fn(async () => ({
      membership_id: 'm1',
      before_role_keys: ['recruiter'],
      after_role_keys: ['finance', 'recruiter'],
      added_role_keys: ['finance'],
      removed_role_keys: [],
    }));
    const onSaved = vi.fn();
    renderEditor({ assignFn, onSaved });

    fireEvent.click(screen.getByLabelText(/^Finance/));
    fireEvent.click(screen.getByTestId('role-assign-save'));

    await waitFor(() => expect(assignFn).toHaveBeenCalledTimes(1));
    expect(assignFn).toHaveBeenCalledWith({
      userId: 'u1',
      body: { role_keys: ['finance', 'recruiter'] },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('D5 — an invertible role-union surfaces the bundle-naming message, not the raw cause', async () => {
    const assignFn = vi.fn(async () => {
      throw new ApiError(400, 'union', 'VALIDATION_ERROR', {
        reason: 'invertible_role_union',
        role_keys: ['finance', 'recruiter'],
        cause: 'role composite scope union [compensation:view:pay, …]',
      });
    });
    renderEditor({ assignFn });
    fireEvent.click(screen.getByLabelText(/^Finance/));
    fireEvent.click(screen.getByTestId('role-assign-save'));

    await waitFor(() =>
      expect(
        screen.getByText(/These roles can.t be combined/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Finance \+ Recruiter/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/would expose pay rates/i),
    ).toBeInTheDocument();
    // R10: cause must never surface.
    expect(
      screen.queryByText(/compensation:view:/i),
    ).not.toBeInTheDocument();
  });

  it('S4 — when toggle is known-off, auditor_with_financials is proactively disabled', () => {
    renderEditor({ financials: 'known-off' });
    const checkbox = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('S4 — on unknown probe (403 fallback), option stays enabled and BE rejection is surfaced', async () => {
    const assignFn = vi.fn(async () => {
      throw new ApiError(400, 'gate', 'VALIDATION_ERROR', {
        reason: 'financials_audit_not_enabled',
        role_key: 'auditor_with_financials',
      });
    });
    renderEditor({ assignFn, financials: 'unknown' });

    fireEvent.click(screen.getByLabelText(/^Auditor with Financials/));
    fireEvent.click(screen.getByTestId('role-assign-save'));

    await waitFor(() =>
      expect(
        screen.getByText(/financial-auditor grant is disabled/i),
      ).toBeInTheDocument(),
    );
  });

  it('blocks save with the right message when the set is emptied', async () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText(/^Recruiter/));
    // Now selection is empty + dirty.
    fireEvent.click(screen.getByTestId('role-assign-save'));
    await waitFor(() =>
      expect(
        screen.getByText(/select at least one role/i),
      ).toBeInTheDocument(),
    );
  });
});
