import { render, screen } from '@testing-library/react';
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

describe('ats-web LoginPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    configureAuthConsumer('recruiter');
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
    expect(screen.getByText('Sign in to Aramo ATS with your work account.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/auth/recruiter/login-options', expect.anything());
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

  it('TENANT_CAPABILITY_NOT_ENTITLED: no access to Aramo ATS with an App Home link (no buttons)', () => {
    renderAt('/login?error=TENANT_CAPABILITY_NOT_ENTITLED');
    expect(screen.getByText('You don’t have access to Aramo ATS')).toBeInTheDocument();
    expect(screen.getByTestId('login-open-app-home')).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull();
  });
});
