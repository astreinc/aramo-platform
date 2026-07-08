import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { VerifyEmailConfirmPage } from './VerifyEmailConfirmPage';

// TR-3 B2 — the public confirm page is ORACLE-RESISTANT: every failure collapses
// to ONE generic failure state; there is no reason discrimination.

function renderAt(
  token: string | null,
  confirmFn: (t: string) => Promise<{ status: 'VERIFIED' }>,
) {
  const url =
    token === null
      ? '/email-verifications/confirm'
      : `/email-verifications/confirm?token=${encodeURIComponent(token)}`;
  return render(
    <MemoryRouter initialEntries={[url]}>
      <VerifyEmailConfirmPage confirmFn={confirmFn} />
    </MemoryRouter>,
  );
}

describe('VerifyEmailConfirmPage', () => {
  it('200 → success (email verified)', async () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt('good-token', confirmFn);
    await waitFor(() =>
      expect(screen.getByTestId('verify-confirm-success')).toBeInTheDocument(),
    );
    expect(confirmFn).toHaveBeenCalledWith('good-token');
  });

  it('404 NOT_FOUND → the single generic failure state', async () => {
    const confirmFn = vi.fn(() =>
      Promise.reject(new ApiError(404, 'not found', 'NOT_FOUND', {})),
    );
    renderAt('a-bad-token', confirmFn);
    await waitFor(() =>
      expect(screen.getByTestId('verify-confirm-failure')).toBeInTheDocument(),
    );
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it('missing token → failure WITHOUT a network call', async () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt(null, confirmFn);
    await waitFor(() =>
      expect(screen.getByTestId('verify-confirm-failure')).toBeInTheDocument(),
    );
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('renders the Aramo wordmark (standalone brand, no shell)', async () => {
    const confirmFn = vi.fn(() =>
      Promise.reject(new ApiError(404, 'not found', 'NOT_FOUND', {})),
    );
    renderAt('t', confirmFn);
    await waitFor(() =>
      expect(
        screen.getByTestId('verify-email-confirm-page'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Aramo')).toBeInTheDocument();
  });
});
