import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { LoginPage } from './LoginPage';

// platform-web login landing — clean entry auto-redirects; errors render a page.
function renderAt(path: string, onMount = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LoginPage onMount={onMount} />
    </MemoryRouter>,
  );
  return onMount;
}

describe('platform-web LoginPage', () => {
  it('auto-redirects on the clean entry (no ?error=)', () => {
    expect(renderAt('/login')).toHaveBeenCalledTimes(1);
  });

  it('generic error → "Sign-in failed" with retry, no auto-redirect', () => {
    const onMount = renderAt('/login?error=AUTH_FAILED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Sign-in failed')).toBeInTheDocument();
  });

  // Host-binding SSO recovery — e.g. an ATS Microsoft account reached the console.
  it('TENANT_ACCESS_DENIED → wrong-account recovery (no auto-redirect, no plain retry)', () => {
    const onMount = renderAt('/login?error=TENANT_ACCESS_DENIED');
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByText('Signed in with a different account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with a different account/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try signing in again/i })).toBeNull();
  });
});
