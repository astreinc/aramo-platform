import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The signed-out page's only side-effecting dependency is redirectToLogin. Mock
// the session module so we can prove (a) it is NOT called on mount (no automatic
// re-authentication — the headline HF3 invariant), and (b) it IS called only on
// the explicit "Sign in again" action, reusing the canonical login entry.
const redirectToLogin = vi.fn();
vi.mock('../auth/session', () => ({ redirectToLogin: () => redirectToLogin() }));

import { SignedOut } from './SignedOut';

describe('SignedOut — public signed-out landing (T2-E1-HF3)', () => {
  afterEach(() => redirectToLogin.mockClear());

  it('renders the signed-out state without starting authentication', () => {
    render(<SignedOut />);
    expect(screen.getByText("You're signed out")).toBeInTheDocument();
    // R3: zero automatic re-authentication on render/mount.
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('exposes an explicit "Sign in again" action that invokes redirectToLogin', () => {
    render(<SignedOut />);
    const button = screen.getByRole('button', { name: /sign in again/i });
    expect(redirectToLogin).not.toHaveBeenCalled(); // still not called before the click
    fireEvent.click(button);
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});
