import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { LoginPage } from './LoginPage';

// Inc-3 PR-3.5 (Workstream B) — the login landing renders humane pages for the
// lifecycle error codes the auth-service callback (Workstream A) navigates here
// with, and only auto-redirects on the clean (error-free) entry.
function renderAt(path: string, onMount = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LoginPage onMount={onMount} />
    </MemoryRouter>,
  );
  return onMount;
}

describe('LoginPage', () => {
  it('auto-redirects to the IdP when there is no ?error= (clean entry)', () => {
    const onMount = renderAt('/login');
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/redirecting to sign-in/i)).toBeInTheDocument();
  });

  it('renders the suspended page (with retry) for TENANT_SUSPENDED — no auto-redirect', () => {
    const onMount = renderAt('/login?error=TENANT_SUSPENDED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Workspace suspended')).toBeInTheDocument();
    expect(screen.getByText(/has been suspended/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try signing in again/i }),
    ).toBeInTheDocument();
  });

  it('renders the closed page WITHOUT a retry for TENANT_CLOSED (terminal)', () => {
    const onMount = renderAt('/login?error=TENANT_CLOSED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Workspace closed')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /try signing in again/i }),
    ).not.toBeInTheDocument();
  });

  // D-ORG (§3.D) — product not in the subscription: no retry loop, App Home link.
  it('renders the organization-not-available page for TENANT_CAPABILITY_NOT_ENTITLED (no retry)', () => {
    const onMount = renderAt('/login?error=TENANT_CAPABILITY_NOT_ENTITLED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Organization not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try signing in again/i })).toBeNull();
    expect(screen.getByTestId('login-open-app-home')).toHaveAttribute('href', '/');
  });

  it('renders the generic auth-failure (with retry) for any other code', () => {
    renderAt('/login?error=INVALID_TOKEN');
    expect(screen.getByText('Sign-in failed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try signing in again/i }),
    ).toBeInTheDocument();
  });

  // Host-binding SSO recovery.
  it('renders the wrong-account recovery for TENANT_ACCESS_DENIED — no auto-redirect, no plain retry', () => {
    const onMount = renderAt('/login?error=TENANT_ACCESS_DENIED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Signed in with a different account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with a different account/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign out of microsoft/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try signing in again/i })).toBeNull();
  });
});
