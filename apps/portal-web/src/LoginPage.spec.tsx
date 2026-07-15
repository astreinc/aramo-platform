import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { portalApi } from './portal-api';
import { LoginPage } from './LoginPage';

// Portal P1 PR-3 — the passwordless login landing. portalApi.requestLink rides
// apiClient → fetch; we stub it directly. Covers: the email-entry form, the
// neutral confirmation on submit, and oracle-resistance (a rejected request
// STILL shows the same neutral confirmation — no eligibility signal leaks).

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

function submitEmail(value: string): void {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value },
  });
  fireEvent.click(screen.getByRole('button', { name: /send me a sign-in link/i }));
}

describe('LoginPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the email-entry form', () => {
    renderPage();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /send me a sign-in link/i }),
    ).toBeInTheDocument();
  });

  it('requests a link and shows the neutral confirmation on submit', async () => {
    const spy = vi
      .spyOn(portalApi, 'requestLink')
      .mockResolvedValue(undefined);
    renderPage();

    submitEmail('me@example.com');

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('me@example.com'),
    );
    expect(
      await screen.findByText(/a sign-in link has been sent/i),
    ).toBeInTheDocument();
  });

  it('shows the SAME neutral confirmation when the request fails (oracle-resistant)', async () => {
    vi.spyOn(portalApi, 'requestLink').mockRejectedValue(new Error('boom'));
    renderPage();

    submitEmail('unknown@example.com');

    // No error surfaced — the identical confirmation, so a failure reveals
    // nothing about whether the address is known/eligible.
    expect(
      await screen.findByText(/a sign-in link has been sent/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});
