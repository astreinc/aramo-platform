import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { clientError, errorFromBody } from '../../../api/errors';
import { SIGN_IN_COPY, SignInView } from '../SignInScreen';

describe('Sign in screen (handoff §4.1, directive §7 C-9)', () => {
  it('shows the copy and both providers, and no password or account creation without native signup (iOS)', () => {
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

  it('M-A11: "New to Aramo Sign? Create a free account" under the buttons opens native signup', () => {
    const onCreateAccount = jest.fn();
    render(
      <SignInView onSignIn={jest.fn()} onOpenLink={jest.fn()} onCreateAccount={onCreateAccount} />,
    );
    expect(screen.getByText(SIGN_IN_COPY.newHere)).toBeTruthy();
    fireEvent.press(screen.getByTestId('sign-in-create-account'));
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/password/i)).toBeNull();
  });

  it('M-A11: user_not_provisioned says there is no account yet and offers Create a free account', async () => {
    const denial = errorFromBody(403, {
      error: {
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'x',
        request_id: 'r',
        details: { reason: 'user_not_provisioned' },
      },
    });
    const onCreateAccount = jest.fn();
    render(
      <SignInView
        onSignIn={jest.fn(async () => Promise.reject(denial))}
        onOpenLink={jest.fn()}
        onCreateAccount={onCreateAccount}
      />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-google')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'There’s no Aramo account for this Google account yet.',
    );
    fireEvent.press(screen.getByTestId('sign-in-no-account-create'));
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
  });

  it('without native signup (iOS) user_not_provisioned still points to the web, with no button', async () => {
    const denial = errorFromBody(403, {
      error: {
        code: 'X',
        message: 'x',
        request_id: 'r',
        details: { reason: 'user_not_provisioned' },
      },
    });
    render(
      <SignInView onSignIn={jest.fn(async () => Promise.reject(denial))} onOpenLink={jest.fn()} />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-google')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'There’s no Aramo account for this sign-in. Create one at sign.aramo.ai, or try the other sign-in option.',
    );
    expect(screen.queryByTestId('sign-in-no-account-create')).toBeNull();
    expect(screen.queryByTestId('sign-in-create-account')).toBeNull();
  });
});
