import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// The session probe is irrelevant to /signed-out (the route is public and sits
// OUTSIDE RouteGuard), but stub it so useSession never touches the network in
// jsdom and can never resolve to a state that starts a login.
vi.mock('@aramo/fe-foundation', async (orig) => {
  const actual = await orig<typeof import('@aramo/fe-foundation')>();
  return { ...actual, useSession: () => ({ status: 'unauthenticated' as const }) };
});

import { App } from '../App';

describe('ats-web /signed-out route (T2-E1-HF3)', () => {
  it('renders the public SignedOut landing — not the login/shell, no auto-login', () => {
    render(
      <MemoryRouter initialEntries={['/signed-out']}>
        <App />
      </MemoryRouter>,
    );
    // Public signed-out landing rendered…
    expect(screen.getByText("You're signed out")).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign in again/i }),
    ).toBeInTheDocument();
    // …and NOT the auto-redirecting login page (which would read "Redirecting to sign-in…").
    expect(screen.queryByText(/redirecting to sign-in/i)).not.toBeInTheDocument();
  });
});
