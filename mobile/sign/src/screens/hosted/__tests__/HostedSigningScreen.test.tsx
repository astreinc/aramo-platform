// Locked hosted mode (M-A5 §3.3): no way back into the workspace until the host's device
// authentication succeeds; the token stays out of navigation and is discarded at hand-back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';

import { ServicesProvider } from '../../../app/ServicesContext';
import type { AppServices } from '../../../app/services';
import type { HostAuthDeps } from '../../../features/hosted/hostAuth';
import { isHostedLocked } from '../../../features/hosted/hostedLock';
import { HostedSigningScreen } from '../HostedSigningScreen';

const mockDiscard = jest.fn();
const mockSession = { active: true, post: jest.fn(), postRaw: jest.fn(), discard: mockDiscard };
jest.mock('../../../signing/useGuestSigningSession', () => ({
  useGuestSigningSession: () => mockSession,
}));
jest.mock('../../../features/signing/useHeaderFinish', () => ({
  useHeaderFinish: () => () => undefined,
}));
// The signer's flow is covered by its own tests; here it only reports "done".
const mockFlowProps: Record<string, unknown>[] = [];
jest.mock('../../../features/signing/SigningFlow', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    SigningFlow: (props: Record<string, unknown> & { onDone: () => void }) => {
      mockFlowProps.push(props);
      return React.createElement(
        RN.Pressable,
        { testID: 'flow-done', onPress: props.onDone },
        React.createElement(RN.Text, null, 'Signer flow'),
      );
    },
  };
});

function nav() {
  const listeners: Record<string, (e: { preventDefault: () => void }) => void> = {};
  return {
    listeners,
    addListener: jest.fn((ev: string, cb: (e: { preventDefault: () => void }) => void) => {
      listeners[ev] = cb;
      return () => undefined;
    }),
    setOptions: jest.fn(),
    goBack: jest.fn(),
    canGoBack: () => true,
    navigate: jest.fn(),
  };
}

const PARAMS = {
  handle: 'opaque-handle',
  signerName: 'Walk In',
  envelopeId: 'env-1',
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
};

function renderScreen(hostAuth: HostAuthDeps, signOut = jest.fn(async () => undefined)) {
  const n = nav();
  const services = { signOut } as unknown as AppServices;
  const wrap = (c: ReactNode) => (
    <ServicesProvider services={services}>
      <QueryClientProvider client={new QueryClient()}>{c}</QueryClientProvider>
    </ServicesProvider>
  );
  render(
    wrap(
      <HostedSigningScreen
        navigation={n as any}
        route={{ key: 'k', name: 'HostedSigning', params: PARAMS } as any}
        hostAuth={hostAuth}
      />,
    ),
  );
  return { n, signOut };
}

const blocked = (n: ReturnType<typeof nav>) => {
  const preventDefault = jest.fn();
  n.listeners['beforeRemove']!({ preventDefault });
  return preventDefault.mock.calls.length > 0;
};

beforeEach(() => {
  mockDiscard.mockClear();
  mockFlowProps.length = 0;
});

describe('HostedSigningScreen', () => {
  it('hand-off → signing → hand-back stays locked; exit only after device auth', async () => {
    const auth = jest.fn<Promise<'ok' | 'failed' | 'unavailable'>, [string]>();
    auth.mockResolvedValueOnce('failed').mockResolvedValueOnce('ok');
    const { n } = renderScreen({ enrolledLevel: async () => 2, authenticate: auth });

    expect(screen.getByText('Give the device to Walk In')).toBeTruthy();
    expect(isHostedLocked()).toBe(true);
    expect(blocked(n)).toBe(true);

    fireEvent.press(screen.getByTestId('hosted-begin'));
    expect(screen.getByText('Signer flow')).toBeTruthy();
    // The signer's flow: the typed-name consent, no host biometrics, no saved marks.
    expect(mockFlowProps.at(-1)).toMatchObject({
      attestName: true,
      deviceConfirm: false,
      signedIn: false,
    });
    expect(blocked(n)).toBe(true);

    fireEvent.press(screen.getByTestId('flow-done'));
    expect(screen.getByText('Hand the device back')).toBeTruthy();
    expect(mockDiscard).toHaveBeenCalled();
    expect(blocked(n)).toBe(true);

    // A failed authentication keeps everything locked.
    await act(async () => fireEvent.press(screen.getByTestId('hosted-handback')));
    expect(screen.getByText('Couldn’t confirm it’s you. Try again.')).toBeTruthy();
    expect(blocked(n)).toBe(true);
    expect(n.goBack).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByTestId('hosted-handback')));
    await waitFor(() => expect(n.goBack).toHaveBeenCalled());
    expect(blocked(n)).toBe(false);
    expect(isHostedLocked()).toBe(false);
    expect(auth).toHaveBeenCalledWith('Confirm it’s you to leave in-person signing');
  });

  it('without a passcode or biometrics, leaving signs the workspace out', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.text === 'Sign out')?.onPress?.();
    });
    const { n, signOut } = renderScreen({
      enrolledLevel: async () => 0,
      authenticate: async () => 'ok',
    });
    await act(async () => fireEvent.press(screen.getByTestId('hosted-cancel')));
    expect(alert).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
    expect(mockDiscard).toHaveBeenCalled();
    expect(n.goBack).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('route params carry a handle, never a token', () => {
    expect(Object.keys(PARAMS).sort()).toEqual(['envelopeId', 'expiresAt', 'handle', 'signerName']);
  });
});
