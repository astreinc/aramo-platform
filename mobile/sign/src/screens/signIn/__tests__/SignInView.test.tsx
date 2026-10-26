import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { clientError, errorFromBody } from '../../../api/errors';
import { SIGN_IN_COPY, SignInView } from '../SignInScreen';

describe('Sign in screen (handoff §4.1, directive §7 C-9)', () => {
  it('shows the copy and both providers, and no password or account creation', () => {
    render(<SignInView onSignIn={jest.fn()} onOpenLink={jest.fn()} />);
    for (const text of [
      SIGN_IN_COPY.title,
      SIGN_IN_COPY.subtitle,
      SIGN_IN_COPY.microsoft,
      SIGN_IN_COPY.google,
      SIGN_IN_COPY.footnote,
      'Terms',
      'Privacy',
      'Help',
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.queryByText(/password/i)).toBeNull();
    expect(screen.queryByText(/create account|sign up/i)).toBeNull();
  });

  it('while signing in, the tapped button reads "Signing in…" and both are disabled', async () => {
    let finish: () => void = () => undefined;
    const onSignIn = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<SignInView onSignIn={onSignIn} onOpenLink={jest.fn()} />);
    fireEvent.press(screen.getByTestId('sign-in-microsoft'));
    expect(onSignIn).toHaveBeenCalledWith('microsoft');
    expect(screen.getByText(SIGN_IN_COPY.busy)).toBeTruthy();
    expect(screen.getByTestId('sign-in-microsoft').props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
    expect(screen.getByTestId('sign-in-google').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await act(async () => finish());
    expect(screen.queryByText(SIGN_IN_COPY.busy)).toBeNull();
  });

  it('a Personal Microsoft refusal shows "Personal accounts sign in with Google."', async () => {
    const refusal = errorFromBody(403, {
      error: {
        code: 'FORBIDDEN',
        message: 'x',
        request_id: 'r',
        details: { reason: 'idp_not_permitted_for_tenant' },
      },
    });
    render(
      <SignInView onSignIn={jest.fn(async () => Promise.reject(refusal))} onOpenLink={jest.fn()} />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-microsoft')));
    expect(screen.getByText('Personal accounts sign in with Google.')).toBeTruthy();
  });

  it('a cancelled browser shows no error; an expired session explains itself', async () => {
    render(
      <SignInView
        onSignIn={jest.fn(async () => Promise.reject(clientError('auth_cancelled')))}
        onOpenLink={jest.fn()}
        sessionExpired
      />,
    );
    expect(screen.getByText(SIGN_IN_COPY.expired)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-google')));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
