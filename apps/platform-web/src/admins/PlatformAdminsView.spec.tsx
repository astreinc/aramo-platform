import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STAFF_EMAIL_HINT, adminInviteErrorText, adminsApi, isStaffEmail } from './admins-api';
import { PlatformAdminsView } from './PlatformAdminsView';

// PLATFORM-UX-1 F-8 (handoff §9 Platform admins; directive R-8, R-13) — the
// invite card mirrors the @aramo.ai rule, "Review invitation…" opens the
// TypedConfirm dialog whose commit unlocks only on an exact match, the server
// refusal is mapped, and the admins list is the designed empty state.

const RESULT = { tenant_id: 't0', user_id: 'u9', membership_id: 'm9', role_keys: ['super_admin'], status: 'invitation_sent' as const };

describe('admins api helpers', () => {
  it('mirrors the @aramo.ai staff-email rule', () => {
    expect(isStaffEmail('dev@aramo.ai')).toBe(true);
    expect(isStaffEmail(' Dev@ARAMO.ai ')).toBe(true);
    expect(isStaffEmail('dev@aramo.ai.evil.com')).toBe(false);
    expect(isStaffEmail('dev@gmail.com')).toBe(false);
    expect(isStaffEmail('@aramo.ai')).toBe(false);
  });

  it('maps the invite refusals', () => {
    expect(
      adminInviteErrorText(new ApiError(400, 'no', 'VALIDATION_ERROR', { reason: 'platform_admin_domain_not_allowed' })),
    ).toBe(STAFF_EMAIL_HINT);
    expect(adminInviteErrorText(new ApiError(409, 'dup', 'INVITATION_ALREADY_EXISTS'))).toBe('This person is already a platform admin.');
    expect(adminInviteErrorText(new ApiError(409, 'taken', 'EMAIL_UNAVAILABLE'))).toContain('another organization');
    expect(adminInviteErrorText(new Error('net'))).toBe('The invitation couldn’t be sent. Try again.');
  });
});

describe('PlatformAdminsView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the invite card and the designed empty admins list (no dashed tag)', () => {
    render(<PlatformAdminsView />);
    expect(screen.getByRole('heading', { name: 'Platform admins' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invite platform admin' })).toBeInTheDocument();
    expect(screen.getByText('Current platform admins')).toBeInTheDocument();
    expect(screen.getByText("The list of current platform admins isn't available yet.")).toBeInTheDocument();
    expect(screen.queryByText(/NEEDS BACKEND/)).toBeNull();
  });

  it('shows the staff-email hint and does not open the review for a non-staff email', () => {
    render(<PlatformAdminsView />);
    const email = screen.getByLabelText('Staff email');
    fireEvent.change(email, { target: { value: 'dev@gmail.com' } });
    expect(screen.getByText(STAFF_EMAIL_HINT)).toBeInTheDocument();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Review invitation…' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps commit disabled until the email is typed back exactly, then sends and confirms', async () => {
    const invite = vi.spyOn(adminsApi, 'invitePlatformAdmin').mockResolvedValue(RESULT);
    render(<PlatformAdminsView />);
    fireEvent.change(screen.getByLabelText('Staff email'), { target: { value: ' Dev.Raman@aramo.ai ' } });
    expect(screen.queryByText(STAFF_EMAIL_HINT)).toBeNull();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Dev Raman' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review invitation…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite platform admin' });
    expect(dialog).toHaveTextContent('with all 10 platform permissions');
    expect(dialog).toHaveTextContent('Type dev.raman@aramo.ai exactly.');
    const commit = within(dialog).getByRole('button', { name: 'Send admin invitation' });
    const typed = within(dialog).getByLabelText('Type the email to confirm');
    expect(commit).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'dev.raman@aramo.a' } });
    expect(commit).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'dev.raman@aramo.ai' } });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(invite).toHaveBeenCalledWith({ email: 'dev.raman@aramo.ai', display_name: 'Dev Raman' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent to dev.raman@aramo.ai.');
    expect(screen.getByLabelText('Staff email')).toHaveValue('');
  });

  it('maps the server domain refusal inside the dialog', async () => {
    vi.spyOn(adminsApi, 'invitePlatformAdmin').mockRejectedValue(
      new ApiError(400, 'Platform administrators must use an allowed operator email domain', 'VALIDATION_ERROR', {
        reason: 'platform_admin_domain_not_allowed',
      }),
    );
    render(<PlatformAdminsView />);
    fireEvent.change(screen.getByLabelText('Staff email'), { target: { value: 'ops@aramo.ai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review invitation…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type the email to confirm'), { target: { value: 'ops@aramo.ai' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send admin invitation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(STAFF_EMAIL_HINT);
  });
});
