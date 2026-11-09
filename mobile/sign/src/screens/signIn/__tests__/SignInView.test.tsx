import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { clientError, errorFromBody } from '../../../api/errors';
import { LINK_COPY } from '../linkPanelModel';
import { providerOrder, SIGN_IN_COPY, SignInView } from '../SignInScreen';

describe('Sign in screen (handoff §4.1, directive §7 C-9)', () => {
  it('shows the copy and both providers, and no password or account creation without native signup (iOS)', () => {
    render(<SignInView onSignIn={jest.fn()} onOpenLink={jest.fn()} />);
    for (const text of [
      SIGN_IN_COPY.title,
      SIGN_IN_COPY.subtitle,
      SIGN_IN_COPY.microsoft,
      SIGN_IN_COPY.google,
      SIGN_IN_COPY.apple,
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

  it('a Personal Microsoft refusal shows the provider-neutral copy (Apple Go-Live W4)', async () => {
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
    expect(
      screen.getByText(
        'Your account doesn’t use this sign-in option. Sign in the way you usually do.',
      ),
    ).toBeTruthy();
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
      'There’s no Aramo account for this sign-in yet.',
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

const HANDLE = 'aGFuZGxlLWhhbmRsZS1oYW5kbGUtaGFuZGxlLTMyYg';

function denial(reason: string, details: Record<string, unknown> = {}) {
  return errorFromBody(403, {
    error: {
      code: 'INSUFFICIENT_PERMISSIONS',
      message: 'x',
      request_id: 'r',
      details: { reason, ...details },
    },
  });
}

describe('Sign in with Apple (Apple Go-Live R-2, W4)', () => {
  it('Apple is a black "Sign in with Apple" button, first on iOS and last elsewhere', () => {
    expect(providerOrder('ios')).toEqual(['apple', 'microsoft', 'google']);
    expect(providerOrder('android')).toEqual(['microsoft', 'google', 'apple']);
    const onSignIn = jest.fn(async () => undefined);
    render(<SignInView onSignIn={onSignIn} onOpenLink={jest.fn()} />);
    const ids = screen.getAllByRole('button').map((b) => b.props.testID as string | undefined);
    expect(ids.filter((i) => i?.startsWith('sign-in-'))).toEqual([
      'sign-in-apple',
      'sign-in-microsoft',
      'sign-in-google',
    ]);
    expect(screen.getByTestId('sign-in-apple')).toHaveStyle({ backgroundColor: '#000000' });
    fireEvent.press(screen.getByTestId('sign-in-apple'));
    expect(onSignIn).toHaveBeenCalledWith('apple');
  });

  it('W5: the Create a free account entry point is offered (iOS too)', () => {
    const onCreateAccount = jest.fn();
    render(
      <SignInView onSignIn={jest.fn()} onOpenLink={jest.fn()} onCreateAccount={onCreateAccount} />,
    );
    fireEvent.press(screen.getByTestId('sign-in-create-account'));
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
  });
});

describe('pending link panels (Apple Go-Live A1 L-3, L-7)', () => {
  function linkApi() {
    return {
      start: jest.fn(async () => undefined),
      verify: jest.fn(async () => ({ idp: 'apple' as const })),
    };
  }

  it('path 3 (conflict): proof (a) re-signs-in with another provider carrying the handle', async () => {
    const api = linkApi();
    const onSignIn = jest
      .fn()
      .mockRejectedValueOnce(denial('idp_identity_conflict', { link_handle: HANDLE, idp: 'apple' }))
      .mockResolvedValueOnce({ linkRefused: null });
    render(<SignInView onSignIn={onSignIn} onOpenLink={jest.fn()} linkApi={api} />);
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-apple')));
    expect(screen.getByText(LINK_COPY.conflictTitle)).toBeTruthy();
    expect(screen.queryByTestId('sign-in-google')).toBeNull();
    expect(screen.queryByTestId('link-prove-apple')).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId('link-prove-google')));
    expect(onSignIn).toHaveBeenLastCalledWith('google', { linkHandle: HANDLE });
  });

  it('path 3 (conflict): proof (b) sends the code to the account email (no email typed), then Continue with Apple', async () => {
    const api = linkApi();
    const onSignIn = jest
      .fn()
      .mockRejectedValueOnce(denial('idp_identity_conflict', { link_handle: HANDLE, idp: 'apple' }))
      .mockResolvedValueOnce(undefined);
    render(<SignInView onSignIn={onSignIn} onOpenLink={jest.fn()} linkApi={api} />);
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-apple')));
    await act(async () => fireEvent.press(screen.getByTestId('link-email-code')));
    expect(api.start).toHaveBeenCalledWith(HANDLE, undefined);
    expect(screen.getByText(LINK_COPY.codeSentConflict)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('link-code'), '123456');
    await act(async () => fireEvent.press(screen.getByTestId('link-verify')));
    expect(api.verify).toHaveBeenCalledWith(HANDLE, '123456');
    expect(screen.getByText(LINK_COPY.linkedTitle('apple'))).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('link-continue')));
    expect(onSignIn).toHaveBeenLastCalledWith('apple');
  });

  it('path 2 (unmatched Apple): relay hint, Connect → typed email → code; a wrong code shows tries left', async () => {
    const api = linkApi();
    api.verify.mockRejectedValueOnce(
      errorFromBody(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'x',
          request_id: 'r',
          details: { reason: 'code_invalid', attempts_remaining: 4 },
        },
      }),
    );
    const onCreateAccount = jest.fn();
    render(
      <SignInView
        onSignIn={jest.fn(async () =>
          Promise.reject(denial('user_not_provisioned', { link_handle: HANDLE, idp: 'apple' })),
        )}
        onOpenLink={jest.fn()}
        linkApi={api}
        onCreateAccount={onCreateAccount}
      />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-apple')));
    expect(screen.getByText(LINK_COPY.unmatchedTitle('apple'))).toBeTruthy();
    expect(screen.getByTestId('link-apple-relay')).toHaveTextContent(LINK_COPY.appleRelayHint);
    fireEvent.press(screen.getByTestId('link-create'));
    expect(onCreateAccount).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('link-connect'));
    fireEvent.press(screen.getByTestId('link-email-code'));
    fireEvent.changeText(screen.getByTestId('link-email'), ' pat@example.com ');
    await act(async () => fireEvent.press(screen.getByTestId('link-send-code')));
    expect(api.start).toHaveBeenCalledWith(HANDLE, 'pat@example.com');
    fireEvent.changeText(screen.getByTestId('link-code'), '000000');
    await act(async () => fireEvent.press(screen.getByTestId('link-verify')));
    expect(screen.getByTestId('link-error')).toHaveTextContent(
      'That code isn’t right. 4 tries left.',
    );
  });

  it('an expired link ends the panel; Cancel returns to the buttons', async () => {
    const api = linkApi();
    api.verify.mockRejectedValueOnce(
      errorFromBody(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'x',
          request_id: 'r',
          details: { reason: 'link_expired' },
        },
      }),
    );
    render(
      <SignInView
        onSignIn={jest.fn(async () =>
          Promise.reject(denial('idp_identity_conflict', { link_handle: HANDLE, idp: 'google' })),
        )}
        onOpenLink={jest.fn()}
        linkApi={api}
      />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-google')));
    await act(async () => fireEvent.press(screen.getByTestId('link-email-code')));
    fireEvent.changeText(screen.getByTestId('link-code'), '123456');
    await act(async () => fireEvent.press(screen.getByTestId('link-verify')));
    expect(screen.getByTestId('link-error')).toHaveTextContent(LINK_COPY.expired('google'));
    fireEvent.press(screen.getByTestId('link-restart'));
    expect(screen.getByTestId('sign-in-google')).toBeTruthy();
  });

  it('a refusal without a handle keeps the old behaviour (no panel)', async () => {
    render(
      <SignInView
        onSignIn={jest.fn(async () => Promise.reject(denial('user_not_provisioned')))}
        onOpenLink={jest.fn()}
        linkApi={linkApi()}
      />,
    );
    await act(async () => fireEvent.press(screen.getByTestId('sign-in-google')));
    expect(screen.queryByTestId('link-panel-unmatched')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
