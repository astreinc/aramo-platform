import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MICROSOFT_SIGN_OUT_URL } from '../auth/session';

import { WrongAccountRecovery } from './WrongAccountRecovery';

// Host-binding SSO recovery — the ?error=TENANT_ACCESS_DENIED page.
describe('WrongAccountRecovery', () => {
  it('performs NO navigation on render (explicit recovery only)', () => {
    const onSelectAccount = vi.fn();
    const onSignOut = vi.fn();
    render(<WrongAccountRecovery onSelectAccount={onSelectAccount} onSignOut={onSignOut} />);
    expect(screen.getByText('Signed in with a different account')).toBeInTheDocument();
    expect(onSelectAccount).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('"Sign in with a different account" → the account-picker login', () => {
    const onSelectAccount = vi.fn();
    render(<WrongAccountRecovery onSelectAccount={onSelectAccount} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with a different account/i }));
    expect(onSelectAccount).toHaveBeenCalledTimes(1);
  });

  it('"Sign out and start over" → the shared logout', () => {
    const onSignOut = vi.fn();
    render(<WrongAccountRecovery onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('button', { name: /sign out and start over/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('the Microsoft sign-out link is the fixed constant (no parameters) with rel=noopener', () => {
    render(<WrongAccountRecovery />);
    const link = screen.getByRole('link', { name: /sign out of microsoft/i });
    expect(link).toHaveAttribute('href', MICROSOFT_SIGN_OUT_URL);
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('discloses no tenant, workspace or account identity', () => {
    const { container } = render(<WrongAccountRecovery />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/@|tenant|workspace id|astre|aramo\.ai/i);
  });
});
