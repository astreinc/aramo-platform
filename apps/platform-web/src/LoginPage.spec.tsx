import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage, PlatformSignedOut } from './LoginPage';

// AUTH-SIGNIN-1 §3.3 — this app's /login is the shared Aramo sign-in screen
// (behaviour is covered in fe-foundation SignInPage.spec.tsx); these pin the
// app wiring and its per-app copy.
function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('platform-web LoginPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    configureAuthConsumer('platform');
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ providers: ['microsoft', 'google'] }), { status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureAuthConsumer('recruiter');
  });

  it('renders the Aramo sign-in screen with both provider buttons and no automatic navigation', async () => {
    renderAt('/login');
    expect(screen.getByText('Sign in with your Aramo staff account.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/auth/platform/login-options', expect.anything());
  });

  it('renders the callback error with the buttons (TENANT_SUSPENDED)', async () => {
    renderAt('/login?error=TENANT_SUSPENDED');
    expect(screen.getByText('Workspace suspended')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
  });

  it('TENANT_CLOSED is terminal (no buttons)', () => {
    renderAt('/login?error=TENANT_CLOSED');
    expect(screen.getByText('Workspace closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull();
  });

  it('TENANT_ACCESS_DENIED keeps the wrong-account recovery', () => {
    renderAt('/login?error=TENANT_ACCESS_DENIED');
    expect(screen.getByText('Signed in with a different account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign out of microsoft/i })).toBeInTheDocument();
  });

  // PLATFORM-UX-1 F-2 (R-17, amendment 14) — the platform copy via errorCopy.
  it('VALIDATION_ERROR shows the session-ended copy with the provider buttons', async () => {
    renderAt('/login?error=VALIDATION_ERROR');
    expect(screen.getByText('Your session ended.')).toBeInTheDocument();
    expect(screen.getByText('Sign in again to continue.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
  });

  it('INTERNAL_ERROR shows the provider-failure copy with the provider buttons', async () => {
    renderAt('/login?error=INTERNAL_ERROR');
    expect(screen.getByText('The sign-in provider didn’t respond.')).toBeInTheDocument();
    expect(screen.getByText('Try again, or use the other provider.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });

  it('TENANT_ACCESS_DENIED keeps the account-switch action', () => {
    renderAt('/login?error=TENANT_ACCESS_DENIED');
    expect(screen.getByRole('button', { name: 'Sign in with a different account' })).toBeInTheDocument();
  });

  it('the signed-out page carries the platform copy and both re-entry buttons, with no navigation', () => {
    render(
      <MemoryRouter initialEntries={['/signed-out']}>
        <PlatformSignedOut />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: "You've signed out securely" })).toBeInTheDocument();
    expect(screen.getByText('Your Platform administration session has ended on this device.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with a different account' })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('/session'), expect.anything());
  });
});
