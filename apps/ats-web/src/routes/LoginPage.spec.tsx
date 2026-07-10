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

  it('renders the generic auth-failure (with retry) for any other code', () => {
    renderAt('/login?error=INVALID_TOKEN');
    expect(screen.getByText('Sign-in failed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try signing in again/i }),
    ).toBeInTheDocument();
  });
});
