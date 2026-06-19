import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';
import { ToastProvider } from '@aramo/fe-foundation';

import { InviteDialog } from './InviteDialog';

function renderDialog(opts?: {
  inviteFn?: typeof import('./users-api').inviteTenantUser;
  onInvited?: () => void;
  financials?: 'known-on' | 'known-off' | 'unknown';
}) {
  const onInvited = opts?.onInvited ?? vi.fn();
  const inviteFn = opts?.inviteFn ?? vi.fn();
  const financialsToggle =
    opts?.financials === 'known-on'
      ? ({ state: 'known' as const, enabled: true })
      : opts?.financials === 'known-off'
        ? ({ state: 'known' as const, enabled: false })
        : ({ state: 'unknown' as const });
  return render(
    <ToastProvider>
      <InviteDialog
        open={true}
        onOpenChange={() => undefined}
        onInvited={onInvited}
        financialsToggle={financialsToggle}
        inviteFn={inviteFn}
      />
    </ToastProvider>,
  );
}

describe('InviteDialog', () => {
  it('renders the form and the role-picker', () => {
    renderDialog();
    expect(screen.getByLabelText(/^Email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Display name$/i)).toBeInTheDocument();
    expect(screen.getByText(/Select one or more roles/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Recruiter/)).toBeInTheDocument();
  });

  it('keeps the Send invite button disabled until email + at least one role', () => {
    renderDialog();
    const submit = screen.getByTestId('invite-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: 'a@b.test' },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/^Recruiter/));
    expect(submit.disabled).toBe(false);
  });

  it('calls inviteFn with the sorted role_keys + trimmed email', async () => {
    const inviteFn = vi.fn(async () => ({
      user_id: 'u1',
      membership_id: 'm1',
      cognito_sub: 's1',
    }));
    const onInvited = vi.fn();
    renderDialog({ inviteFn, onInvited });

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: '  a@b.test  ' },
    });
    fireEvent.click(screen.getByLabelText(/^Recruiter/));
    fireEvent.click(screen.getByLabelText(/^Finance/));
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(inviteFn).toHaveBeenCalledTimes(1));
    expect(inviteFn).toHaveBeenCalledWith({
      email: 'a@b.test',
      display_name: null,
      // Sorted asc — matches the backend's audit-row primary identity.
      role_keys: ['finance', 'recruiter'],
    });
    await waitFor(() => expect(onInvited).toHaveBeenCalledTimes(1));
  });

  it('D5 — an invertible role-union surfaces the BUNDLE-NAMING message, not the raw cause', async () => {
    const inviteFn = vi.fn(async () => {
      throw new ApiError(400, 'union', 'VALIDATION_ERROR', {
        reason: 'invertible_role_union',
        role_keys: ['finance', 'recruiter'],
        cause:
          'role composite:finance+recruiter scope union [compensation:view:pay, compensation:view:spread] is invertible',
      });
    });
    renderDialog({ inviteFn });

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: 'a@b.test' },
    });
    fireEvent.click(screen.getByLabelText(/^Recruiter/));
    fireEvent.click(screen.getByLabelText(/^Finance/));
    fireEvent.click(screen.getByTestId('invite-submit'));

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
    // The R10 line: scope-key math MUST NOT leak.
    expect(
      screen.queryByText(/compensation:view:/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/scope union/i),
    ).not.toBeInTheDocument();
  });

  it('S4 — when financials are known-off, auditor_with_financials is proactively disabled', () => {
    renderDialog({ financials: 'known-off' });
    const checkbox = screen.getByLabelText(
      /^Auditor with Financials/,
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('S4 — on a 403 probe (unknown), the option stays selectable and we trust the BE rejection', async () => {
    const inviteFn = vi.fn(async () => {
      throw new ApiError(400, 'gate', 'VALIDATION_ERROR', {
        reason: 'financials_audit_not_enabled',
        role_key: 'auditor_with_financials',
      });
    });
    renderDialog({ inviteFn, financials: 'unknown' });

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: 'a@b.test' },
    });
    fireEvent.click(screen.getByLabelText(/^Auditor with Financials/));
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() =>
      expect(
        screen.getByText(/financial-auditor grant is disabled/i),
      ).toBeInTheDocument(),
    );
    // The Settings-pointing detail.
    expect(
      screen.getByText(/Enable "Financial-auditor grant" in Settings/i),
    ).toBeInTheDocument();
  });
});
