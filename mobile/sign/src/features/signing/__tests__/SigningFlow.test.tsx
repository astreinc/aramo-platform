// Consent is never pre-checked and shows the versioned disclosure; an ended link shows
// the recovery copy (C-21) — on the guest transport only.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { ServicesProvider } from '../../../app/ServicesContext';
import type { AppServices } from '../../../app/services';
import { ToastProvider } from '../../../components/Toast';
import { memoryKv, recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SigningFlow } from '../SigningFlow';

jest.mock('react-native-pdf', () => 'Pdf');
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.setTimeout(30_000);

const BASE = 'https://sign.aramo.ai';

function wrap(children: ReactNode) {
  const { workspace } = workspaceWith(() => ({ status: 200, body: {} }));
  const services = { kv: memoryKv(), workspace } as unknown as AppServices;
  return (
    <ServicesProvider services={services}>
      <ToastProvider>{children}</ToastProvider>
    </ServicesProvider>
  );
}

describe('SigningFlow', () => {
  it('consent is not pre-checked; Continue stays disabled until checked; disclosure is versioned', async () => {
    const net = recordingFetch((req) =>
      req.url.endsWith('/disclosure-text')
        ? {
            status: 200,
            body: {
              disclosure_version: '1.0',
              text: 'You agree to sign electronically.',
              text_sha256: 'a'.repeat(64),
              message: 'Please sign by Friday',
            },
          }
        : { status: 200, body: {} },
    );
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    render(
      wrap(
        <SigningFlow
          session={session}
          signerName=""
          signedIn={false}
          senderName="Northwind"
          subject="Offer"
          onDone={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), {
      timeout: 15_000,
    });
    expect(screen.getByTestId('consent-check').props.accessibilityState).toMatchObject({
      checked: false,
    });
    expect(screen.getByTestId('consent-continue').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByText('“Please sign by Friday”')).toBeTruthy();
    fireEvent.press(screen.getByText('Read the disclosure'));
    expect(screen.getByText('Version 1.0')).toBeTruthy();
    expect(screen.getByText('You agree to sign electronically.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('consent-check'));
    expect(screen.getByTestId('consent-continue').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    // Only guest calls, never with workspace credentials.
    for (const c of net.calls)
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    // Signed out: no inbox claim is offered.
    expect(screen.queryByText('Save to my inbox')).toBeNull();
  });

  it('a revoked or expired link shows the recovery message and is not retried', async () => {
    const net = recordingFetch(() => ({
      status: 401,
      body: { error: { code: 'SIGNING_SESSION_EXPIRED' } },
    }));
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    render(
      wrap(<SigningFlow session={session} signerName="" signedIn={false} onDone={jest.fn()} />),
    );
    await waitFor(() => expect(screen.getByTestId('signing-ended')).toBeTruthy());
    expect(
      screen.getByText(
        'This link was replaced or has expired. Open the newest email, or sign in to your inbox.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(net.calls).toHaveLength(1);
  });

  it('an out-of-turn signer sees "Waiting for …"', async () => {
    const net = recordingFetch(() => ({
      status: 409,
      body: { error: { code: 'SIGNER_NOT_YET_ELIGIBLE' } },
    }));
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    render(
      wrap(<SigningFlow session={session} signerName="" signedIn={false} onDone={jest.fn()} />),
    );
    await waitFor(() => expect(screen.getByTestId('signing-waiting')).toBeTruthy());
    expect(screen.getByText('Waiting for an earlier signer')).toBeTruthy();
  });

  it('hosted session: the signer types their name, sent as attested_name with the acceptance', async () => {
    const net = recordingFetch((req) =>
      req.url.endsWith('/disclosure-text')
        ? {
            status: 200,
            body: {
              disclosure_version: '1.0',
              text: 'T',
              text_sha256: 'b'.repeat(64),
              message: null,
            },
          }
        : req.url.endsWith('/document')
          ? { status: 200, body: { documents: [], fields: [], message: null } }
          : { status: 200, body: {} },
    );
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    render(
      wrap(
        <SigningFlow
          session={session}
          signerName="Walk In"
          signedIn={false}
          attestName
          deviceConfirm={false}
          onDone={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('attested-name')).toBeTruthy(), {
      timeout: 15_000,
    });
    fireEvent.press(screen.getByTestId('consent-check'));
    // Checked but no name yet: still disabled.
    expect(screen.getByTestId('consent-continue').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    fireEvent.changeText(screen.getByTestId('attested-name'), '  Walk In  ');
    expect(screen.getByTestId('consent-continue').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    fireEvent.press(screen.getByTestId('consent-continue'));
    await waitFor(() =>
      expect(net.calls.some((c) => c.url.endsWith('/v1/sign/signing/disclosure'))).toBe(true),
    );
    const accept = net.calls.find((c) => c.url.endsWith('/v1/sign/signing/disclosure'))!;
    expect(accept.body).toMatchObject({ attested_name: 'Walk In', disclosure_version: '1.0' });
  });

  it('other sessions send no attested_name and show no name field', async () => {
    const net = recordingFetch((req) =>
      req.url.endsWith('/disclosure-text')
        ? {
            status: 200,
            body: {
              disclosure_version: '1.0',
              text: 'T',
              text_sha256: 'b'.repeat(64),
              message: null,
            },
          }
        : { status: 200, body: {} },
    );
    const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
      SIGNING_TOKEN,
    );
    render(
      wrap(<SigningFlow session={session} signerName="" signedIn={false} onDone={jest.fn()} />),
    );
    await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), {
      timeout: 15_000,
    });
    expect(screen.queryByTestId('attested-name')).toBeNull();
    fireEvent.press(screen.getByTestId('consent-check'));
    fireEvent.press(screen.getByTestId('consent-continue'));
    await waitFor(() =>
      expect(net.calls.some((c) => c.url.endsWith('/v1/sign/signing/disclosure'))).toBe(true),
    );
    const accept = net.calls.find((c) => c.url.endsWith('/v1/sign/signing/disclosure'))!;
    expect(accept.body).not.toHaveProperty('attested_name');
  });
});
