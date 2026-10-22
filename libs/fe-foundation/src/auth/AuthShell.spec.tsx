import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AUTH_PRODUCTS, AuthShell } from './AuthShell';

// The frame's optional props are additive: without them every product's sign-in
// and signed-out screens render exactly as before.

describe('AuthShell', () => {
  it('defaults: the identity-provider note, a "Sign in" card region, no extra classes', () => {
    render(
      <AuthShell product={AUTH_PRODUCTS.ats}>
        <p>card</p>
      </AuthShell>,
    );
    expect(
      screen.getByText("Sign-in is handled by your organization's identity provider."),
    ).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Sign in' });
    expect(card).toHaveAttribute('class', 'aramo-auth__card');
    expect(screen.getByTestId('aramo-signin')).toHaveAttribute('class', 'aramo-auth');
  });

  it('a product can replace the note, the card label and add classes', () => {
    render(
      <AuthShell
        product={AUTH_PRODUCTS.sign}
        idpNote="No passwords."
        cardLabel="Create your account"
        cardClassName="x-card"
        className="x-root"
      >
        <p>card</p>
      </AuthShell>,
    );
    expect(screen.getByText('No passwords.')).toBeInTheDocument();
    expect(screen.queryByText(/identity provider/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Create your account' })).toHaveClass(
      'aramo-auth__card',
      'x-card',
    );
    expect(screen.getByTestId('aramo-signin')).toHaveClass('aramo-auth', 'x-root');
  });
});
