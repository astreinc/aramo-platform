import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { VerifyEmailConfirmPage } from './VerifyEmailConfirmPage';

// ATI-SEP-1 T10 WP3b — the public 6-digit code entry page (Talent Intelligence OTP).

const VID = '0190ffff-0000-7000-8000-0000000000aa';

function renderAt(query: string | null, confirmFn: (id: string, code: string) => Promise<{ status: 'VERIFIED' }>) {
  const url = query === null ? '/email-verifications/confirm' : `/email-verifications/confirm?${query}`;
  return render(
    <MemoryRouter initialEntries={[url]}>
      <VerifyEmailConfirmPage confirmFn={confirmFn} />
    </MemoryRouter>,
  );
}

function enter(code: string) {
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('VerifyEmailConfirmPage (OTP)', () => {
  it('a correct code → verified; the id comes from ?verification_id=', async () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt(`verification_id=${VID}`, confirmFn);
    enter('123456');
    await waitFor(() => expect(screen.getByTestId('verify-confirm-success')).toBeInTheDocument());
    expect(confirmFn).toHaveBeenCalledWith(VID, '123456');
  });

  it('accepts ?id= as the verification id', async () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt(`id=${VID}`, confirmFn);
    enter('654321');
    await waitFor(() => expect(confirmFn).toHaveBeenCalledWith(VID, '654321'));
  });

  it('a wrong code keeps the form and shows the attempts left', async () => {
    const confirmFn = vi.fn(() =>
      Promise.reject(new ApiError(422, 'refused', 'IDENTIFIER_VERIFICATION_REFUSED', { reason: 'INVALID_CODE', attempts_remaining: 3 })),
    );
    renderAt(`verification_id=${VID}`, confirmFn);
    enter('000000');
    expect(await screen.findByText(/That code isn’t right\. 3 attempts left\./)).toBeInTheDocument();
    expect(screen.getByTestId('verify-confirm-form')).toBeInTheDocument();
  });

  it('expired / locked end the flow with a plain message', async () => {
    const expired = vi.fn(() =>
      Promise.reject(new ApiError(422, 'refused', 'IDENTIFIER_VERIFICATION_REFUSED', { reason: 'VERIFICATION_EXPIRED' })),
    );
    const { unmount } = renderAt(`verification_id=${VID}`, expired);
    enter('111111');
    expect(await screen.findByText('This code has expired')).toBeInTheDocument();
    unmount();
    const locked = vi.fn(() =>
      Promise.reject(new ApiError(422, 'refused', 'IDENTIFIER_VERIFICATION_REFUSED', { reason: 'VERIFICATION_LOCKED' })),
    );
    renderAt(`verification_id=${VID}`, locked);
    enter('111111');
    expect(await screen.findByText('Too many attempts')).toBeInTheDocument();
  });

  it('already confirmed → verified', async () => {
    const confirmFn = vi.fn(() =>
      Promise.reject(new ApiError(422, 'refused', 'IDENTIFIER_VERIFICATION_REFUSED', { reason: 'ALREADY_CONFIRMED' })),
    );
    renderAt(`verification_id=${VID}`, confirmFn);
    enter('222222');
    await waitFor(() => expect(screen.getByTestId('verify-confirm-success')).toBeInTheDocument());
  });

  it('an unknown verification (404) → the invalid-link state', async () => {
    const confirmFn = vi.fn(() => Promise.reject(new ApiError(404, 'not found', 'NOT_FOUND', {})));
    renderAt(`verification_id=${VID}`, confirmFn);
    enter('333333');
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it('TI unavailable (503) keeps the form with a retry message', async () => {
    const confirmFn = vi.fn(() =>
      Promise.reject(new ApiError(503, 'unavailable', 'INTELLIGENCE_UNAVAILABLE', { intelligence_status: 'UNAVAILABLE' })),
    );
    renderAt(`verification_id=${VID}`, confirmFn);
    enter('444444');
    expect(await screen.findByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByTestId('verify-confirm-form')).toBeInTheDocument();
  });

  it('missing verification id → failure WITHOUT a network call', () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt(null, confirmFn);
    expect(screen.getByTestId('verify-confirm-failure')).toBeInTheDocument();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('the Verify button is disabled until 6 digits are entered; non-digits are stripped', () => {
    const confirmFn = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    renderAt(`verification_id=${VID}`, confirmFn);
    const button = screen.getByRole('button', { name: 'Verify' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '12a34' } });
    expect((screen.getByLabelText('Verification code') as HTMLInputElement).value).toBe('1234');
    expect(button).toBeDisabled();
    expect(screen.getByText('Aramo')).toBeInTheDocument();
  });
});
