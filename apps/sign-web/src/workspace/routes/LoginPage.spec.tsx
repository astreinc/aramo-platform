import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from './LoginPage';

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

describe('sign-web workspace LoginPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    configureAuthConsumer('sign');
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
    expect(screen.getByText('Sign in to send, manage, and sign documents.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/auth/sign/login-options', expect.anything());
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

  it('TENANT_CAPABILITY_NOT_ENTITLED: no access to Aramo Sign (no provider buttons)', () => {
    renderAt('/login?error=TENANT_CAPABILITY_NOT_ENTITLED');
    expect(screen.getByText('You don’t have access to Aramo Sign')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull();
  });

  it('TENANT_ACCESS_DENIED keeps the wrong-account recovery', () => {
    renderAt('/login?error=TENANT_ACCESS_DENIED');
    expect(screen.getByText('Signed in with a different account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign out of microsoft/i })).toBeInTheDocument();
  });

  function mockSignup(personal: number, business: number) {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/v1/signup/sign/personal/terms') return new Response('{}', { status: personal });
      if (url === '/v1/signup/sign/terms') return new Response('{}', { status: business });
      return new Response(JSON.stringify({ providers: ['microsoft', 'google'] }), { status: 200 });
    });
  }

  it('offers both sign-up links while both sign-ups are on', async () => {
    mockSignup(200, 200);
    renderAt('/login');
    expect(await screen.findByRole('link', { name: 'Create a Personal account' })).toHaveAttribute('href', '/signup/personal');
    expect(screen.getByRole('link', { name: 'Create a Business account' })).toHaveAttribute('href', '/signup');
  });

  it('offers only the sign-up that is on (Personal on, Business 404)', async () => {
    mockSignup(200, 404);
    renderAt('/login');
    expect(await screen.findByRole('link', { name: 'Create a Personal account' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create a Business account' })).toBeNull();
  });

  it('offers no sign-up links while both are off', async () => {
    mockSignup(404, 404);
    renderAt('/login');
    await screen.findByRole('button', { name: 'Continue with Microsoft' });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/v1/signup/sign/terms', expect.anything()));
    expect(screen.queryByTestId('signin-create-account')).toBeNull();
  });

  it('hides the links when the availability probe fails', async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/v1/signup/')) throw new TypeError('network');
      return new Response(JSON.stringify({ providers: ['microsoft', 'google'] }), { status: 200 });
    });
    renderAt('/login');
    await screen.findByRole('button', { name: 'Continue with Microsoft' });
    expect(screen.queryByTestId('signin-create-account')).toBeNull();
  });

  it('the no-account screen offers the sign-up links too', async () => {
    mockSignup(200, 200);
    renderAt('/login?error=INSUFFICIENT_PERMISSIONS');
    expect(await screen.findByRole('link', { name: 'Create a Business account' })).toBeInTheDocument();
  });

  // Apple Go-Live A1 L-3 path 2 — on the Sign host the no-account pending-link
  // panel offers "Create a new account" (the Personal signup, Apple-first).
  it('a pending Apple link with no account offers to connect an account or create one', async () => {
    mockSignup(200, 200);
    renderAt(`/login?error=INSUFFICIENT_PERMISSIONS&reason=user_not_provisioned&consumer=sign#link=${'k'.repeat(43)}&idp=apple`);
    expect(screen.getByText('No Aramo account uses this Apple ID yet')).toBeInTheDocument();
    expect(await screen.findByTestId('link-create-account')).toHaveAttribute('href', '/signup/personal');
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
  });

  it('an unverified Microsoft email gets its own explanation', () => {
    renderAt('/login?error=VALIDATION_ERROR&reason=idp_email_unverified');
    expect(screen.getByText('Your Microsoft account’s email isn’t verified')).toBeInTheDocument();
  });
});
