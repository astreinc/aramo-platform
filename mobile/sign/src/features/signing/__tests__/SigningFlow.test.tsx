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

  // UAT SEC-04 — an access-code recipient opening the link in the app.
  describe('access code', () => {
    const required = {
      status: 403,
      body: { error: { code: 'SIGNER_ACCESS_CODE_REQUIRED', details: { reason: 'access_code_required' } } },
    };
    const disclosure = {
      status: 200,
      body: { disclosure_version: '1.0', text: 'You agree.', text_sha256: 'a'.repeat(64) },
    };
    function flow(onCode: (code: string) => { status: number; body: unknown }) {
      let verified = false;
      const net = recordingFetch((req) => {
        if (req.url.endsWith('/access-code')) {
          const code = String((req.body as { access_code?: unknown } | null)?.access_code);
          const r = onCode(code);
          if (r.status === 200) verified = true;
          return r;
        }
        if (req.url.endsWith('/exchange')) return { status: 200, body: {} };
        if (!verified) return required;
        return req.url.endsWith('/disclosure-text') ? disclosure : { status: 200, body: {} };
      });
      const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
      render(wrap(<SigningFlow session={session} signerName="" signedIn={false} onDone={jest.fn()} />));
      return net;
    }

    it('asks for the code, shows the attempts left, then opens with the right code', async () => {
      flow((code) =>
        code === 'Blue-42'
          ? { status: 200, body: { verified: true } }
          : {
              status: 403,
              body: { error: { code: 'SIGNER_ACCESS_CODE_REQUIRED', details: { reason: 'access_code_incorrect', attempts_remaining: 4 } } },
            },
      );
      await waitFor(() => expect(screen.getByTestId('signing-accesscode')).toBeTruthy(), { timeout: 15_000 });
      expect(screen.getByText('Enter the access code')).toBeTruthy();
      fireEvent.changeText(screen.getByLabelText('Access code'), 'wrong');
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() =>
        expect(screen.getByText('That code isn’t right. 4 attempts left before this document is locked.')).toBeTruthy(),
      );
      fireEvent.changeText(screen.getByLabelText('Access code'), 'Blue-42');
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
    });

    it('after the fifth wrong code the document is locked', async () => {
      flow(() => ({
        status: 423,
        body: { error: { code: 'SIGNER_ACCESS_CODE_LOCKED', details: { reason: 'access_code_locked' } } },
      }));
      await waitFor(() => expect(screen.getByTestId('signing-accesscode')).toBeTruthy(), { timeout: 15_000 });
      fireEvent.changeText(screen.getByLabelText('Access code'), 'wrong');
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByText('Too many incorrect access codes')).toBeTruthy());
      expect(screen.queryByTestId('consent-check')).toBeNull();
    });
  });

  // UAT SEC-04 follow-up — SMS code and identity check recipients in the app.
  describe('SMS code and identity check', () => {
    const disclosure = {
      status: 200,
      body: { disclosure_version: '1.0', text: 'You agree.', text_sha256: 'a'.repeat(64) },
    };
    function flow(gate: { status: number; body: unknown }, routes: Record<string, () => { status: number; body: unknown }>) {
      let cleared = false;
      const net = recordingFetch((req) => {
        const hit = Object.keys(routes).find((k) => req.url.endsWith(k));
        if (hit) {
          const r = routes[hit]!();
          if ((r.body as { verified?: unknown; state?: unknown } | null)?.verified === true || (r.body as { state?: unknown } | null)?.state === 'VERIFIED')
            cleared = true;
          return r;
        }
        if (req.url.endsWith('/exchange')) return { status: 200, body: {} };
        if (!cleared) return gate;
        return req.url.endsWith('/disclosure-text') ? disclosure : { status: 200, body: {} };
      });
      const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
      render(wrap(<SigningFlow session={session} signerName="" signedIn={false} onDone={jest.fn()} />));
      return net;
    }

    it('SMS: texts a code, a wrong code says so, the right code opens the document', async () => {
      let verifies = 0;
      flow(
        { status: 403, body: { error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'recipient_verification_required' } } } },
        {
          '/verification': () => ({ status: 200, body: { required: true, verified: false, locked: false, phone: '+1•••••••23' } }),
          '/sms-otp/send': () => ({ status: 200, body: { sent: true, verified: false, phone: '+1•••••••23' } }),
          '/sms-otp/verify': () =>
            ++verifies === 1
              ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', details: { reason: 'otp_mismatch' } } } }
              : { status: 200, body: { verified: true } },
        },
      );
      await waitFor(() => expect(screen.getByTestId('signing-smscode')).toBeTruthy(), { timeout: 15_000 });
      await waitFor(() => expect(screen.getByText(/\+1•••••••23/)).toBeTruthy());
      fireEvent.press(screen.getByText('Text me a code'));
      await waitFor(() => expect(screen.getByLabelText('Code')).toBeTruthy());
      fireEvent.changeText(screen.getByLabelText('Code'), '000000');
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByText('That code isn’t right. Check it and try again.')).toBeTruthy());
      fireEvent.changeText(screen.getByLabelText('Code'), '123456');
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
    });

    it('SMS: a locked recipient sees the lock message', async () => {
      flow(
        { status: 403, body: { error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'recipient_verification_locked' } } } },
        {},
      );
      await waitFor(() => expect(screen.getByText('Too many incorrect codes')).toBeTruthy(), { timeout: 15_000 });
    });

    it('identity: Continue reads the result and opens the document once verified', async () => {
      let statusCalls = 0;
      flow(
        { status: 403, body: { error: { code: 'SIGNER_IDENTITY_VERIFICATION_REQUIRED', details: { reason: 'identity_verification_required' } } } },
        {
          '/identity-verification/status': () =>
            ++statusCalls === 1
              ? { status: 200, body: { method: 'ID_VERIFICATION', state: 'PENDING', attempts_remaining: 3, last_failure: null } }
              : { status: 200, body: { method: 'ID_VERIFICATION', state: 'VERIFIED', attempts_remaining: 3, last_failure: null } },
        },
      );
      await waitFor(() => expect(screen.getByTestId('signing-identity')).toBeTruthy(), { timeout: 15_000 });
      expect(screen.getByText('Verify your identity to open this document')).toBeTruthy();
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByText(/Your check is not finished yet/)).toBeTruthy());
      fireEvent.press(screen.getByText('Continue'));
      await waitFor(() => expect(screen.getByTestId('consent-check')).toBeTruthy(), { timeout: 15_000 });
    });

    it('identity: a locked check shows the result', async () => {
      flow(
        { status: 423, body: { error: { code: 'SIGNER_IDENTITY_VERIFICATION_LOCKED', details: { reason: 'identity_verification_locked' } } } },
        {},
      );
      await waitFor(() => expect(screen.getByText('We couldn’t verify your identity')).toBeTruthy(), { timeout: 15_000 });
    });
  });
});
