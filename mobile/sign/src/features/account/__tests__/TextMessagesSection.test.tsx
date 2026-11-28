// SMS-CONSENT-1 §2 / §3 — Account → Text messages and the optional step after signup in the
// app: hidden while texts are not available; verify the number, then a separate unticked
// consent saved with the wording version and channel; Turn off; Remove number; "Not now".
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { WorkspaceClient, WorkspaceRequest } from '../../../api/workspaceClient';
import { clearSmsSignupOffer, markSmsSignupOffer, smsSignupOfferPending } from '../smsConsent';
import { SMS_CONSENT_WORDING, SMS_SIGNUP_STEP_TITLE } from '../smsConsentCopy';
import { SmsSignupStep, TextMessagesSection } from '../TextMessagesSection';

const NONE = {
  available: true,
  phone_masked: null,
  phone_verified: false,
  consented: false,
  consented_at: null,
  wording_version: '2026-11-28',
  wording: SMS_CONSENT_WORDING,
};
const VERIFIED = { ...NONE, phone_masked: '+1••••••••23', phone_verified: true };
const ON = { ...VERIFIED, consented: true, consented_at: '2026-11-28T10:00:00Z' };

/** A workspace whose GET returns `state()`; writes run `onWrite` and are recorded. */
function workspace(state: () => unknown, onWrite: (req: WorkspaceRequest) => unknown = () => ({})) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const request = jest.fn(async (req: WorkspaceRequest) => {
    if (req.method === 'GET')
      return { status: 200, data: state(), etag: null, headers: new Headers() };
    writes.push({ method: req.method, path: req.path, body: req.body });
    return { status: 200, data: onWrite(req), etag: null, headers: new Headers() };
  });
  return { ws: { request } as unknown as WorkspaceClient, request, writes };
}

describe('Account → Text messages (app)', () => {
  it('renders nothing while texts are not available', async () => {
    const { ws, request } = workspace(() => ({ ...NONE, available: false }));
    render(<TextMessagesSection workspace={ws} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('account-text-messages')).toBeNull();
  });

  it('verifies the number, then the unticked consent saves with the wording version and APP', async () => {
    let state: unknown = NONE;
    const { ws, writes } = workspace(
      () => state,
      (req) => {
        if (req.path.endsWith('/phone')) return { sent: true, phone_masked: '+1••••••••23' };
        if (req.path.endsWith('/verify')) state = VERIFIED;
        if (req.method === 'PUT') state = ON;
        return {};
      },
    );
    render(<TextMessagesSection workspace={ws} />);
    fireEvent.changeText(await screen.findByTestId('sms-consent-phone'), '+14155550123');
    fireEvent.press(screen.getByTestId('sms-consent-send-code'));
    await screen.findByText('We texted a code to +1••••••••23.');
    fireEvent.changeText(screen.getByTestId('sms-consent-code'), '123456');
    fireEvent.press(screen.getByTestId('sms-consent-verify'));
    const box = await screen.findByTestId('sms-consent-agree');
    expect(box.props.accessibilityState).toEqual({ checked: false });
    expect(screen.getByTestId('sms-consent-wording')).toHaveTextContent(SMS_CONSENT_WORDING);
    expect(screen.getByTestId('sms-consent-save')).toBeDisabled();
    fireEvent.press(box);
    fireEvent.press(screen.getByTestId('sms-consent-save'));
    await screen.findByTestId('sms-consent-on');
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/v1/sign/me/sms-consent/phone',
        body: { phone_e164: '+14155550123' },
      },
      { method: 'POST', path: '/v1/sign/me/sms-consent/verify', body: { code: '123456' } },
      {
        method: 'PUT',
        path: '/v1/sign/me/sms-consent',
        body: { consented: true, wording_version: '2026-11-28', channel: 'APP' },
      },
    ]);
  });

  it('a number not in international format is not sent', async () => {
    const { ws, writes } = workspace(() => NONE);
    render(<TextMessagesSection workspace={ws} />);
    fireEvent.changeText(await screen.findByTestId('sms-consent-phone'), '415 555 0123');
    expect(screen.getByTestId('sms-consent-send-code')).toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  it('Turn off saves consented false; Remove number deletes', async () => {
    const { ws, writes } = workspace(() => ON);
    render(<TextMessagesSection workspace={ws} />);
    fireEvent.press(await screen.findByTestId('sms-consent-turn-off'));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.press(screen.getByTestId('sms-consent-remove'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      {
        method: 'PUT',
        path: '/v1/sign/me/sms-consent',
        body: { consented: false, wording_version: '2026-11-28', channel: 'APP' },
      },
      { method: 'DELETE', path: '/v1/sign/me/sms-consent', body: undefined },
    ]);
  });
});

describe('the optional step after signup (app)', () => {
  afterEach(() => clearSmsSignupOffer());

  it('is not shown (nor read) without a signup in this session', () => {
    const { ws, request } = workspace(() => NONE);
    render(<SmsSignupStep workspace={ws} />);
    expect(screen.queryByTestId('sms-signup-step')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('is not shown while texts are not available, and is not kept for later', async () => {
    markSmsSignupOffer();
    const { ws } = workspace(() => ({ ...NONE, available: false }));
    render(<SmsSignupStep workspace={ws} />);
    await waitFor(() => expect(smsSignupOfferPending()).toBe(false));
    expect(screen.queryByTestId('sms-signup-step')).toBeNull();
  });

  it('"Not now" skips it', async () => {
    markSmsSignupOffer();
    const { ws, writes } = workspace(() => NONE);
    render(<SmsSignupStep workspace={ws} />);
    expect(await screen.findByText(SMS_SIGNUP_STEP_TITLE)).toBeTruthy();
    fireEvent.press(screen.getByTestId('sms-signup-skip'));
    expect(screen.queryByTestId('sms-signup-step')).toBeNull();
    expect(smsSignupOfferPending()).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('opens the same flow, saving consent with channel SIGNUP', async () => {
    markSmsSignupOffer();
    const { ws, writes } = workspace(() => VERIFIED);
    render(<SmsSignupStep workspace={ws} />);
    fireEvent.press(await screen.findByTestId('sms-signup-start'));
    const box = await screen.findByTestId('sms-consent-agree');
    expect(box.props.accessibilityState).toEqual({ checked: false });
    fireEvent.press(box);
    fireEvent.press(screen.getByTestId('sms-consent-save'));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: 'PUT',
          path: '/v1/sign/me/sms-consent',
          body: { consented: true, wording_version: '2026-11-28', channel: 'SIGNUP' },
        },
      ]),
    );
  });
});
