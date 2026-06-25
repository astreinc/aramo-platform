import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { InvitationAcceptPage } from './InvitationAcceptPage';

// Invite-S3 (§5) — the public accept page branches on EVERY response.

function renderAt(
  token: string | null,
  acceptFn: (t: string) => Promise<{ status: 'ACCEPTED'; tenant_id: string }>,
) {
  const url =
    token === null
      ? '/invitations/accept'
      : `/invitations/accept?token=${encodeURIComponent(token)}`;
  return render(
    <MemoryRouter initialEntries={[url]}>
      <InvitationAcceptPage acceptFn={acceptFn} />
    </MemoryRouter>,
  );
}

function reject400(reason: string) {
  return Object.assign(
    () =>
      Promise.reject(
        new ApiError(400, 'invalid', 'VALIDATION_ERROR', { reason }),
      ),
    {},
  );
}

describe('InvitationAcceptPage', () => {
  it('200 → success with a sign-in link (no forced sign-in)', async () => {
    const acceptFn = vi.fn(async () => ({
      status: 'ACCEPTED' as const,
      tenant_id: 't1',
    }));
    renderAt('good-token', acceptFn);
    await waitFor(() =>
      expect(screen.getByTestId('accept-success')).toBeInTheDocument(),
    );
    expect(acceptFn).toHaveBeenCalledWith('good-token');
    expect(screen.getByTestId('accept-signin')).toBeInTheDocument();
  });

  it('missing token → invalid WITHOUT a network call', async () => {
    const acceptFn = vi.fn(async () => ({
      status: 'ACCEPTED' as const,
      tenant_id: 't1',
    }));
    renderAt(null, acceptFn);
    await waitFor(() =>
      expect(screen.getByTestId('accept-invalid')).toBeInTheDocument(),
    );
    expect(acceptFn).not.toHaveBeenCalled();
  });

  it('400 expired → expired message (ask admin to resend)', async () => {
    renderAt('t', reject400('expired'));
    await waitFor(() =>
      expect(screen.getByTestId('accept-expired')).toBeInTheDocument(),
    );
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });

  it('400 already_accepted → already + sign-in link', async () => {
    renderAt('t', reject400('already_accepted'));
    await waitFor(() =>
      expect(screen.getByTestId('accept-already')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('accept-signin')).toBeInTheDocument();
  });

  it('400 revoked → cancelled (contact admin)', async () => {
    renderAt('t', reject400('revoked'));
    await waitFor(() =>
      expect(screen.getByTestId('accept-revoked')).toBeInTheDocument(),
    );
  });

  it('400 invalid_token → invalid message', async () => {
    renderAt('t', reject400('invalid_token'));
    await waitFor(() =>
      expect(screen.getByTestId('accept-invalid')).toBeInTheDocument(),
    );
  });

  it('network / unexpected error → graceful generic', async () => {
    renderAt('t', () => Promise.reject(new Error('network down')));
    await waitFor(() =>
      expect(screen.getByTestId('accept-error')).toBeInTheDocument(),
    );
  });

  it('renders the Aramo wordmark (standalone brand, no shell)', async () => {
    renderAt('t', reject400('revoked'));
    await waitFor(() =>
      expect(screen.getByTestId('invitation-accept-page')).toBeInTheDocument(),
    );
    expect(screen.getByText('Aramo')).toBeInTheDocument();
  });
});
