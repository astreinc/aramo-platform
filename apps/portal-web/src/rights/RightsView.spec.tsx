import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { portalApi } from '../portal-api';

import { RightsView } from './RightsView';

// Portal P4b — the RTBF screen. portalApi stubbed at the method seam. Covers: the
// grave what-is/isn't-erased copy + type-to-confirm gate, a successful erase →
// terminal state (+ UUID key), and the confirmation-mismatch (400) path.

describe('RightsView', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows what is / is not deleted and gates the button until an email is typed', () => {
    render(<RightsView />);
    expect(screen.getByText('What is deleted')).toBeInTheDocument();
    expect(screen.getByText('What is NOT deleted')).toBeInTheDocument();
    const btn = screen.getByRole('button', {
      name: 'Permanently delete my identity',
    });
    expect(btn).toBeDisabled();
  });

  it('erases on confirm and lands on the terminal deleted state (UUID key)', async () => {
    const erase = vi
      .spyOn(portalApi, 'eraseSelf')
      .mockResolvedValue({ erased: true });
    render(<RightsView />);

    fireEvent.change(
      screen.getByLabelText('Type your email address to confirm'),
      { target: { value: 'me@example.com' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my identity' }),
    );

    await waitFor(() => expect(erase).toHaveBeenCalledTimes(1));
    expect(erase).toHaveBeenCalledWith(
      'me@example.com',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(
      await screen.findByText('Your identity has been deleted'),
    ).toBeInTheDocument();
  });

  it('surfaces a friendly message on a confirmation mismatch (400)', async () => {
    vi.spyOn(portalApi, 'eraseSelf').mockRejectedValue(
      new ApiError(400, 'confirmation does not match', 'VALIDATION_ERROR'),
    );
    render(<RightsView />);

    fireEvent.change(
      screen.getByLabelText('Type your email address to confirm'),
      { target: { value: 'wrong@example.com' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Permanently delete my identity' }),
    );

    expect(
      await screen.findByText(/does not match the address you sign in with/),
    ).toBeInTheDocument();
  });
});
