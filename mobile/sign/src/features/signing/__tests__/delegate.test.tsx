// Consolidated Directive v1.0 B3 — "Ask someone else to sign": offered only when the
// signer view says can_delegate; a hand-off ends this link; refusals are plain words.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { ServicesProvider } from '../../../app/ServicesContext';
import type { AppServices } from '../../../app/services';
import { ToastProvider } from '../../../components/Toast';
import { memoryKv, recordingFetch, SIGNING_TOKEN, type RecordedRequest } from '../../../testing/fakes';
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { SigningFlow } from '../SigningFlow';
import { DELEGATE_COPY, delegatedCopy, validDelegate } from '../signingApi';

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

function server(canDelegate: boolean, delegate: (r: RecordedRequest) => { status: number; body: unknown }) {
  return recordingFetch((req) => {
    if (req.url.endsWith('/disclosure-text'))
      return {
        status: 200,
        body: { disclosure_version: '1.0', text: 'T', text_sha256: 'c'.repeat(64), message: null },
      };
    if (req.url.endsWith('/document'))
      return { status: 200, body: { documents: [], fields: [], message: null, can_delegate: canDelegate } };
    if (req.url.endsWith('/delegate')) return delegate(req);
    return { status: 200, body: {} };
  });
}

async function openFields(net: ReturnType<typeof server>) {
  const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
  render(
    wrap(<SigningFlow session={session} signerName="" signedIn={false} deviceConfirm={false} onDone={jest.fn()} />),
  );
  await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
  fireEvent.press(screen.getByTestId('consent-check'));
  fireEvent.press(screen.getByTestId('consent-continue'));
  await waitFor(() => expect(screen.getByTestId('signing-primary')).toBeTruthy(), { timeout: 15_000 });
}

describe('signer delegation (B3)', () => {
  it('is not offered when the view says can_delegate false', async () => {
    const net = server(false, () => ({ status: 200, body: { delegated: true } }));
    await openFields(net);
    expect(screen.queryByTestId('delegate-open')).toBeNull();
  });

  it('hands off: name, email and reason go with the token; the link then ends', async () => {
    const net = server(true, () => ({ status: 200, body: { delegated: true } }));
    await openFields(net);
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('delegate-open'));
    fireEvent.changeText(screen.getByTestId('delegate-name'), ' Ana Ruiz ');
    fireEvent.changeText(screen.getByTestId('delegate-email'), 'ana@example.com');
    fireEvent.changeText(screen.getByTestId('delegate-reason'), 'On leave');
    fireEvent.press(screen.getByTestId('delegate-send'));
    await waitFor(() => expect(screen.getByTestId('signing-delegated')).toBeTruthy());
    expect(screen.getByText(delegatedCopy('Ana Ruiz'))).toBeTruthy();
    const call = net.calls.find((c) => c.url.endsWith('/v1/sign/signing/delegate'))!;
    expect(call.body).toEqual({ name: 'Ana Ruiz', email: 'ana@example.com', reason: 'On leave', token: SIGNING_TOKEN });
  });

  it('shows the refusal in plain words and stays on the sheet', async () => {
    const net = server(true, () => ({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', details: { reason: 'delegate_email_on_envelope' } } },
    }));
    await openFields(net);
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('delegate-open'));
    fireEvent.changeText(screen.getByTestId('delegate-name'), 'Ana Ruiz');
    fireEvent.changeText(screen.getByTestId('delegate-email'), 'ana@example.com');
    fireEvent.press(screen.getByTestId('delegate-send'));
    await waitFor(() => expect(screen.getByText(DELEGATE_COPY.onEnvelope)).toBeTruthy());
    expect(screen.queryByTestId('signing-delegated')).toBeNull();
  });

  it('a 409 refusal says it cannot be handed off; an invalid email is caught before sending', async () => {
    const net = server(true, () => ({
      status: 409,
      body: { error: { code: 'ENVELOPE_ILLEGAL_TRANSITION', details: { reason: 'already_delegated' } } },
    }));
    await openFields(net);
    fireEvent.press(screen.getByTestId('signing-more'));
    fireEvent.press(screen.getByTestId('delegate-open'));
    fireEvent.changeText(screen.getByTestId('delegate-name'), 'Ana Ruiz');
    fireEvent.changeText(screen.getByTestId('delegate-email'), 'not-an-email');
    fireEvent.press(screen.getByTestId('delegate-send'));
    await waitFor(() => expect(screen.getByText(DELEGATE_COPY.invalid)).toBeTruthy());
    expect(net.calls.some((c) => c.url.endsWith('/delegate'))).toBe(false);
    fireEvent.changeText(screen.getByTestId('delegate-email'), 'ana@example.com');
    fireEvent.press(screen.getByTestId('delegate-send'));
    await waitFor(() => expect(screen.getByText(DELEGATE_COPY.refused)).toBeTruthy());
    expect(validDelegate({ name: ' ', email: 'a@b.co' })).toBe(false);
  });
});
