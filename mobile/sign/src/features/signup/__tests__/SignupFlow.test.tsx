// M-A11 §1 / §5 — the native Personal signup flow: every step, every refusal and the decoy
// answers, the Gmail warning, the never-preselected terms box, the stale-terms refetch and
// the build without Play Integrity.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError, clientError } from '../../../api/errors';
import type { IntegritySession } from '../integrity';
import type {
  CompleteResponse,
  NativeStartBody,
  SignupApi,
  TermsListDocument,
  TermsText,
} from '../signupApi';
import { SignupFlow, type SignupDeps } from '../SignupFlow';
import { HELD_COPY, SIGNUP_COPY, type NextStep } from '../signupModel';

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function doc(key: TermsText['key'], version: string, text: string): TermsText {
  return { key, version, sha256: sha(text), effective_at: '2026-11-02T17:00:00.000Z', text };
}
const TOS = doc('sign.terms_of_service', '2.0', 'Aramo Sign Terms of Service text.');
const PRIVACY = doc('aramo.privacy_notice', '1.0', 'Privacy Notice text — “quoted”.');
const AUP = doc('aramo.acceptable_use_policy', '1.0', 'Acceptable Use Policy text.');
const TOS_21 = doc('sign.terms_of_service', '2.1', 'Aramo Sign Terms of Service text, revised.');

const refusal = (status: number, reason: string, details: Record<string, unknown> = {}) =>
  new ApiError({
    status,
    code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
    reason,
    details: { reason, ...details },
  });

function fakeApi(docs: TermsText[][] = [[TOS, PRIVACY, AUP]]) {
  let listCalls = 0;
  const current = () => docs[Math.min(listCalls - 1, docs.length - 1)] ?? [];
  const api = {
    listTerms: jest.fn<Promise<{ off: false; documents: TermsListDocument[] | null }>, []>(
      async () => {
        listCalls += 1;
        return {
          off: false as const,
          documents: current().map((d) => ({
            key: d.key,
            version: d.version,
            sha256: d.sha256,
            url: `https://sign.aramo.ai/legal/${d.key}`,
          })),
        };
      },
    ),
    termsText: jest.fn(async (key: string, version: string) => {
      const d = current().find((x) => x.key === key && x.version === version);
      if (!d) throw refusal(404, 'legal_document_not_found');
      return d;
    }),
    start: jest.fn<Promise<{ signup_id: string }>, [NativeStartBody & { integrity_token: string }]>(
      async () => ({ signup_id: 'su-1' }),
    ),
    resendEmail: jest.fn(async () => undefined),
    verifyEmail: jest.fn<Promise<NextStep>, [string, string]>(async () => 'terms'),
    sendPhoneCode: jest.fn(async () => true),
    verifyPhone: jest.fn<Promise<NextStep>, [string, string]>(async () => 'terms'),
    complete: jest.fn<Promise<CompleteResponse>, [string, readonly unknown[]]>(async () => ({
      status: 'PROVISIONED',
      email: 'pat.lee@gmail.com',
      sign_in: { google: 'https://x' },
      held: null,
    })),
  };
  return api as typeof api & SignupApi;
}

function fakeIntegrity(
  client: 'android' | 'ios' = 'android',
): IntegritySession & { tokenFor: jest.Mock; warmUp: jest.Mock } {
  return { client, warmUp: jest.fn(), tokenFor: jest.fn(async () => 'play-integrity-token') };
}

function setup(over: Partial<SignupDeps> = {}) {
  const api = (over.api as ReturnType<typeof fakeApi> | undefined) ?? fakeApi();
  const integrity = over.integrity === undefined ? fakeIntegrity() : over.integrity;
  const signIn = jest.fn<Promise<unknown>, ['google' | 'apple']>(async () => undefined);
  let clock = 1_000;
  const now = jest.fn(() => clock);
  render(
    <SignupFlow
      api={api}
      integrity={integrity}
      signIn={signIn}
      now={now}
      {...(over.appleIdentity ? { appleIdentity: over.appleIdentity } : {})}
    />,
  );
  return { api, integrity, signIn, advance: (ms: number) => (clock += ms) };
}

function fillDetails(email = 'pat.lee@gmail.com') {
  fireEvent.changeText(screen.getByTestId('signup-name'), '  Pat Lee ');
  fireEvent.changeText(screen.getByTestId('signup-email'), email);
  fireEvent.changeText(screen.getByTestId('signup-phone'), '(415) 555-0100');
  fireEvent.press(screen.getByTestId('signup-residence-US'));
}

async function submitDetails() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('signup-submit'));
  });
}

async function enterCode(code = '123456') {
  fireEvent.changeText(screen.getByTestId('signup-code'), code);
  await act(async () => {
    fireEvent.press(screen.getByTestId('signup-code-submit'));
  });
}

async function toTerms(s: ReturnType<typeof setup>, email?: string) {
  fillDetails(email);
  await submitDetails();
  await enterCode();
  expect(await screen.findByTestId('signup-accept')).toBeTruthy();
  return s;
}

describe('details step', () => {
  it('without Play Integrity (no cloud project number) shows the unavailable message and never calls start', () => {
    const { api } = setup({ integrity: null });
    expect(screen.getByText(SIGNUP_COPY.unavailable)).toBeTruthy();
    expect(screen.queryByTestId('signup-submit')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('shows the Privacy Notice at collection and the MaxMind attribution (plain text, no link); warms up integrity once', () => {
    const { integrity } = setup();
    expect(screen.getByText(SIGNUP_COPY.privacy)).toBeTruthy();
    expect(screen.getByTestId('signup-maxmind')).toHaveTextContent(
      'This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.',
    );
    expect(screen.queryByText('Third-party notices')).toBeNull();
    expect((integrity as ReturnType<typeof fakeIntegrity>).warmUp).toHaveBeenCalledTimes(1);
  });

  it('opens the effective Privacy Notice in-app (verified like the terms) and keeps the typed details', async () => {
    const { api } = setup();
    fillDetails();
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-privacy-link'));
    });
    expect(api.listTerms).toHaveBeenCalledTimes(1);
    expect(api.termsText).toHaveBeenCalledWith('aramo.privacy_notice', '1.0');
    expect(api.termsText).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Aramo Privacy Notice (version 1.0)')).toBeTruthy();
    expect(screen.getByText(PRIVACY.text)).toBeTruthy();
    fireEvent.press(screen.getAllByTestId('signup-privacy-back')[0]!);
    expect(screen.getByTestId('signup-name').props.value).toBe('  Pat Lee ');
    expect(screen.getByTestId('signup-phone').props.value).toBe('(415) 555-0100');
  });

  it('a Privacy Notice whose text does not hash to its sha256 (or is not listed) is not shown; retry reloads', async () => {
    const api = fakeApi([
      [TOS, { ...PRIVACY, text: 'tampered' }, AUP],
      [TOS, AUP],
      [TOS, PRIVACY, AUP],
    ]);
    setup({ api });
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-privacy-link'));
    });
    expect(screen.getByTestId('signup-privacy-failed')).toHaveTextContent(
      SIGNUP_COPY.privacyLoadFailed,
    );
    expect(screen.queryByText('tampered')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-privacy-retry'));
    });
    expect(screen.getByTestId('signup-privacy-failed')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-privacy-retry'));
    });
    expect(screen.getByText(PRIVACY.text)).toBeTruthy();
    expect(api.listTerms).toHaveBeenCalledTimes(3);
  });

  it('nothing in the signup flow opens a browser (PO: 100% native)', () => {
    const dir = resolve(__dirname, '..');
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n))) {
      const src = readFileSync(resolve(dir, f), 'utf8');
      expect([f, /expo-web-browser|openURL|Linking|WebView/.test(src)]).toEqual([f, false]);
    }
  });

  it('checks fields locally before calling start', async () => {
    const { api } = setup();
    await submitDetails();
    expect(screen.getByText('Enter your full name.')).toBeTruthy();
    expect(screen.getByText('Choose where you live.')).toBeTruthy();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('sends the android body with a measured integer elapsed_ms, hp "", invite_code null and the token bound to it', async () => {
    const s = setup();
    fillDetails();
    s.advance(4321);
    await submitDetails();
    const sent = {
      client: 'android',
      name: 'Pat Lee',
      email: 'pat.lee@gmail.com',
      phone: '+14155550100',
      residence: 'US',
      invite_code: null,
      hp: '',
      elapsed_ms: 4321,
    };
    expect((s.integrity as ReturnType<typeof fakeIntegrity>).tokenFor).toHaveBeenCalledWith(sent);
    expect(s.api.start).toHaveBeenCalledWith({ ...sent, integrity_token: 'play-integrity-token' });
    expect(Number.isInteger(s.api.start.mock.calls[0]?.[0].elapsed_ms)).toBe(true);
    expect(
      await screen.findByText(
        'We sent a 6-digit code to pat.lee@gmail.com. It works for 10 minutes.',
      ),
    ).toBeTruthy();
  });

  it('a Play Integrity failure on the device shows a message and never calls start', async () => {
    const integrity = fakeIntegrity();
    integrity.tokenFor.mockRejectedValueOnce(new Error('play'));
    const { api } = setup({ integrity });
    fillDetails();
    await submitDetails();
    expect(screen.getByTestId('signup-failure')).toHaveTextContent(SIGNUP_COPY.integrityFailed);
    expect(api.start).not.toHaveBeenCalled();
  });

  it.each([
    ['business_email_use_business_signup', SIGNUP_COPY.businessEmail],
    ['personal_email_not_allowed', SIGNUP_COPY.disposable],
    ['personal_location_not_supported', SIGNUP_COPY.location],
    ['personal_pilot_full', SIGNUP_COPY.pilotFull],
    ['something_unexpected', SIGNUP_COPY.generic],
  ])('start refusal %s renders native copy', async (reason, copy) => {
    const api = fakeApi();
    api.start.mockRejectedValueOnce(refusal(400, reason));
    setup({ api });
    fillDetails();
    await submitDetails();
    expect(screen.getByTestId('signup-failure')).toHaveTextContent(copy);
  });

  it('rate limit (429), offline, a field refusal and the invite refusals', async () => {
    const api = fakeApi();
    api.start
      .mockRejectedValueOnce(refusal(429, 'rate_limited'))
      .mockRejectedValueOnce(clientError('network_unavailable'))
      .mockRejectedValueOnce(refusal(400, 'VALIDATION_ERROR', { field: 'phone' }))
      .mockRejectedValueOnce(refusal(400, 'invite_required'))
      .mockRejectedValueOnce(refusal(400, 'invite_invalid'));
    setup({ api });
    fillDetails();
    await submitDetails();
    expect(screen.getByTestId('signup-failure')).toHaveTextContent(SIGNUP_COPY.rateLimited);
    await submitDetails();
    expect(screen.getByTestId('signup-failure')).toHaveTextContent(
      'You’re offline. Check your connection and try again.',
    );
    await submitDetails();
    expect(screen.getByText('Enter a 10-digit US mobile number.')).toBeTruthy();
    await submitDetails();
    expect(screen.getByText(SIGNUP_COPY.inviteRequired)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('signup-invite'), ' PILOT-7 ');
    await submitDetails();
    expect(screen.getByText(SIGNUP_COPY.inviteInvalid)).toBeTruthy();
    expect(api.start.mock.calls[4]?.[0].invite_code).toBe('PILOT-7');
  });

  it('signup off (404) shows that Personal accounts are not open', async () => {
    const api = fakeApi();
    api.start.mockRejectedValueOnce(refusal(404, 'NOT_FOUND'));
    setup({ api });
    fillDetails();
    await submitDetails();
    expect(screen.getByTestId('signup-not-open')).toBeTruthy();
    expect(screen.getByText(SIGNUP_COPY.notOpen)).toBeTruthy();
  });
});

describe('decoys stay indistinguishable', () => {
  it('an explicit refusal (risk, integrity fail or integrity unavailable) always shows the same review screen', async () => {
    for (const _ of ['risk', 'integrity_fail', 'integrity_unavailable']) {
      const api = fakeApi();
      api.start.mockRejectedValueOnce(refusal(400, 'personal_signup_refused'));
      setup({ api });
      fillDetails();
      await submitDetails();
      expect(screen.getByTestId('signup-review')).toBeTruthy();
      expect(screen.getByText(SIGNUP_COPY.reviewBody('pat.lee@gmail.com'))).toBeTruthy();
      expect(screen.getByTestId('signup-review-support')).toHaveTextContent(
        'Questions? Contact Aramo support at support@aramo.ai.',
      );
      screen.unmount();
    }
  });

  it('an address that already has an account gets the same code screen and the same wrong-code answer', async () => {
    const rendered: string[] = [];
    for (const email of ['new.person@gmail.com', 'existing.person@gmail.com']) {
      const api = fakeApi();
      api.verifyEmail.mockRejectedValueOnce(
        refusal(400, 'code_invalid', { attempts_remaining: 4 }),
      );
      setup({ api });
      fillDetails(email);
      await submitDetails();
      await enterCode();
      rendered.push(JSON.stringify(screen.toJSON()).replace(new RegExp(email, 'g'), 'EMAIL'));
      expect(screen.getByText('That code isn’t right. 4 tries left.')).toBeTruthy();
      screen.unmount();
    }
    expect(rendered[0]).toBe(rendered[1]);
  });
});

describe('email and phone codes', () => {
  it('needs 6 digits; resend is offered only after 60 seconds', async () => {
    jest.useFakeTimers();
    try {
      const { api } = setup();
      fillDetails();
      await submitDetails();
      expect(screen.getByTestId('signup-resend')).toHaveTextContent('Resend in 1:00');
      fireEvent.press(screen.getByTestId('signup-resend'));
      expect(api.resendEmail).not.toHaveBeenCalled();
      for (let i = 0; i < 60; i += 1) act(() => jest.advanceTimersByTime(1000));
      expect(screen.getByTestId('signup-resend')).toHaveTextContent('Didn’t get it? Resend');
      await act(async () => {
        fireEvent.press(screen.getByTestId('signup-resend'));
      });
      expect(api.resendEmail).toHaveBeenCalledWith('su-1');
      expect(screen.getByTestId('signup-code-notice')).toHaveTextContent('We sent a new code.');
      expect(screen.getByTestId('signup-resend')).toHaveTextContent('Resend in 1:00');
      fireEvent.changeText(screen.getByTestId('signup-code'), '12a4');
      fireEvent.press(screen.getByTestId('signup-code-submit'));
      expect(api.verifyEmail).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('too many wrong codes → start again → back to the details form', async () => {
    const api = fakeApi();
    api.verifyEmail.mockRejectedValueOnce(refusal(400, 'code_attempts_exceeded'));
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(screen.getByText('Too many wrong codes. Start again to get a new code.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('signup-restart'));
    expect(screen.getByTestId('signup-details')).toBeTruthy();
  });

  it('an expired code and an expired signup', async () => {
    const api = fakeApi();
    api.verifyEmail
      .mockRejectedValueOnce(refusal(400, 'code_expired'))
      .mockRejectedValueOnce(refusal(404, 'NOT_FOUND'));
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(screen.getByText('This code has expired. Send a new code.')).toBeTruthy();
    await enterCode();
    expect(screen.getByText('This signup has expired. Start again.')).toBeTruthy();
  });

  it('the phone step appears only when the server says next: phone', async () => {
    const api = fakeApi();
    api.verifyEmail.mockResolvedValueOnce('phone');
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(
      await screen.findByText(
        'We texted a 6-digit code to +1 ••• ••• 0100. Only some new accounts need this step.',
      ),
    ).toBeTruthy();
    expect(api.sendPhoneCode).toHaveBeenCalledTimes(1);
    await enterCode('654321');
    expect(api.verifyPhone).toHaveBeenCalledWith('su-1', '654321');
    expect(await screen.findByTestId('signup-accept')).toBeTruthy();
  });

  it('next: terms skips the phone step', async () => {
    const s = setup();
    await toTerms(s);
    expect(s.api.sendPhoneCode).not.toHaveBeenCalled();
  });

  it('SMS unavailable (sent: false) continues to terms with a notice and ends held for the phone step', async () => {
    const api = fakeApi();
    api.verifyEmail.mockResolvedValueOnce('phone');
    api.sendPhoneCode.mockResolvedValueOnce(false);
    api.complete.mockResolvedValueOnce({
      status: 'PROVISIONED',
      email: 'x',
      sign_in: {},
      held: undefined,
    } as never);
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(await screen.findByText(SIGNUP_COPY.phoneUnavailable)).toBeTruthy();
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(
      screen.getByText(HELD_COPY.phone_verification_required.note, { exact: false }),
    ).toBeTruthy();
  });

  it('a phone send refusal offers start again', async () => {
    const api = fakeApi();
    api.verifyEmail.mockResolvedValueOnce('phone');
    api.sendPhoneCode.mockRejectedValueOnce(refusal(400, 'personal_code_rate_limited'));
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(await screen.findByTestId('signup-phone-error')).toBeTruthy();
    expect(screen.getByText('Too many tries. Wait a minute and try again.')).toBeTruthy();
  });
});

describe('terms', () => {
  it('renders each effective document natively; the box is never preselected; accept sends key, version and sha256', async () => {
    const s = setup();
    await toTerms(s);
    expect(s.api.termsText).toHaveBeenCalledWith('sign.terms_of_service', '2.0');
    expect(screen.getByText('Aramo Sign Terms of Service (version 2.0)')).toBeTruthy();
    expect(screen.getByText(PRIVACY.text)).toBeTruthy();
    expect(screen.getByText(AUP.text)).toBeTruthy();
    expect(screen.getByTestId('signup-accept').props.accessibilityState).toEqual({
      checked: false,
    });
    fireEvent.press(screen.getByTestId('signup-complete'));
    expect(s.api.complete).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('signup-accept'));
    expect(screen.getByTestId('signup-accept').props.accessibilityState).toEqual({ checked: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(s.api.complete).toHaveBeenCalledWith('su-1', [
      { key: TOS.key, version: '2.0', sha256: TOS.sha256 },
      { key: PRIVACY.key, version: '1.0', sha256: PRIVACY.sha256 },
      { key: AUP.key, version: '1.0', sha256: AUP.sha256 },
    ]);
    expect(screen.getByTestId('signup-done')).toBeTruthy();
  });

  it('terms_not_accepted (a document changed) refetches, unticks the box and asks again', async () => {
    const api = fakeApi([
      [TOS, PRIVACY, AUP],
      [TOS_21, PRIVACY, AUP],
    ]);
    api.complete.mockRejectedValueOnce(refusal(400, 'terms_not_accepted'));
    const s = setup({ api });
    await toTerms(s);
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(await screen.findByText('Aramo Sign Terms of Service (version 2.1)')).toBeTruthy();
    expect(screen.getByText(SIGNUP_COPY.termsChanged)).toBeTruthy();
    expect(api.listTerms).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('signup-accept').props.accessibilityState).toEqual({
      checked: false,
    });
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(api.complete).toHaveBeenLastCalledWith('su-1', [
      { key: TOS_21.key, version: '2.1', sha256: TOS_21.sha256 },
      { key: PRIVACY.key, version: '1.0', sha256: PRIVACY.sha256 },
      { key: AUP.key, version: '1.0', sha256: AUP.sha256 },
    ]);
    expect(screen.getByTestId('signup-done')).toBeTruthy();
  });

  it('text that does not hash to its sha256 is never shown for acceptance', async () => {
    const api = fakeApi([[{ ...TOS, text: 'tampered' }, PRIVACY, AUP]]);
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(await screen.findByTestId('signup-terms-failed')).toHaveTextContent(
      SIGNUP_COPY.termsLoadFailed,
    );
    expect(screen.queryByTestId('signup-accept')).toBeNull();
  });

  it('documents not approved → not open yet', async () => {
    const api = fakeApi();
    api.listTerms.mockResolvedValueOnce({ off: false, documents: null });
    setup({ api });
    fillDetails();
    await submitDetails();
    await enterCode();
    expect(await screen.findByTestId('signup-terms-unavailable')).toBeTruthy();
  });

  it.each([
    [refusal(400, 'legal_documents_not_approved'), 'signup-terms-unavailable', null],
    [refusal(404, 'NOT_FOUND'), 'signup-expired', SIGNUP_COPY.expiredTitle],
    [refusal(400, 'personal_signup_refused'), 'signup-review', SIGNUP_COPY.reviewTitle],
    [
      new ApiError({ status: 409, code: 'EMAIL_UNAVAILABLE', reason: 'EMAIL_UNAVAILABLE' }),
      'signup-terms-error',
      SIGNUP_COPY.emailTaken,
    ],
    [refusal(400, 'invite_invalid'), 'signup-terms-error', SIGNUP_COPY.inviteInvalid],
    [refusal(400, 'personal_pilot_full'), 'signup-terms-error', SIGNUP_COPY.pilotFull],
    [
      new ApiError({ status: 500, code: 'INTERNAL_ERROR', reason: 'INTERNAL_ERROR' }),
      'signup-terms-error',
      SIGNUP_COPY.generic,
    ],
  ])('complete refusal %#', async (error, testID, copy) => {
    const api = fakeApi();
    api.complete.mockRejectedValueOnce(error);
    const s = setup({ api });
    await toTerms(s);
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(screen.getByTestId(testID)).toBeTruthy();
    if (copy !== null) expect(screen.getByText(copy)).toBeTruthy();
  });
});

describe('done', () => {
  async function toDone(email: string, held: 'review' | null = null) {
    const api = fakeApi();
    api.complete.mockResolvedValueOnce({
      status: 'PROVISIONED',
      email,
      sign_in: { google: 'x' },
      held,
    });
    const s = setup({ api });
    await toTerms(s, email);
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    return s;
  }

  it('says the account is ready, names the email, warns about Gmail dots and continues with Google or Apple', async () => {
    const s = await toDone('pat.lee@gmail.com');
    expect(screen.getByText('Your account is ready.')).toBeTruthy();
    expect(screen.getByTestId('signup-done-copy')).toHaveTextContent(
      'Sign in with Google or Apple. Use the account for pat.lee@gmail.com.',
    );
    expect(screen.getByTestId('signup-done-gmail')).toHaveTextContent(SIGNUP_COPY.gmail);
    // Apple Go-Live R-5: the email-path done step offers Google and Apple.
    expect(screen.getByTestId('signup-continue-apple')).toHaveTextContent('Continue with Apple');
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-google'));
    });
    expect(s.signIn).toHaveBeenCalledWith('google');
  });

  it('no Gmail warning for other addresses; a review hold is explained', async () => {
    await toDone('pat@outlook.com', 'review');
    expect(screen.queryByTestId('signup-done-gmail')).toBeNull();
    expect(screen.getByText(HELD_COPY.review.note, { exact: false })).toBeTruthy();
  });

  it('a refused Google sign-in shows the refusal; a cancelled one shows nothing', async () => {
    const s = await toDone('pat.lee@gmail.com');
    s.signIn.mockRejectedValueOnce(clientError('auth_cancelled')).mockRejectedValueOnce(
      new ApiError({
        status: 403,
        code: 'INSUFFICIENT_PERMISSIONS',
        reason: 'user_not_provisioned',
      }),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-google'));
    });
    expect(screen.queryByTestId('signup-done-error')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-google'));
    });
    expect(screen.getByTestId('signup-done-error')).toHaveTextContent(
      'There’s no Aramo account for this sign-in yet.',
    );
  });
});

describe('Apple Go-Live (R-5 Apple-first, R-9 iOS client)', () => {
  const APPLE = { email: 'x1y2@privaterelay.appleid.com', givenName: 'Pat', familyName: 'Lee' };

  it('iOS sends client "ios" in the body the token is bound to; the failure copy has no "Google Play"', async () => {
    const integrity = fakeIntegrity('ios');
    const s = setup({ integrity });
    fillDetails();
    await submitDetails();
    expect(integrity.tokenFor.mock.calls[0]![0]).toMatchObject({ client: 'ios' });
    expect(s.api.start.mock.calls[0]![0]).toMatchObject({ client: 'ios' });

    const failing = fakeIntegrity('ios');
    failing.tokenFor.mockRejectedValueOnce(new Error('attest'));
    setup({ integrity: failing });
    fillDetails();
    await submitDetails();
    expect(screen.getByTestId('signup-failure')).toHaveTextContent(SIGNUP_COPY.integrityFailedIos);
    expect(SIGNUP_COPY.integrityFailedIos).not.toMatch(/Google/);
  });

  it('Continue with Apple prefills and locks the email, prefills the name; the email code is still required', async () => {
    const appleIdentity = jest.fn(async () => APPLE);
    const s = setup({ appleIdentity });
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-apple-top'));
    });
    expect(screen.getByTestId('signup-email').props.value).toBe(APPLE.email);
    expect(screen.getByTestId('signup-email').props.editable).toBe(false);
    expect(screen.getByTestId('signup-name').props.value).toBe('Pat Lee');
    expect(screen.getByTestId('signup-apple-prefilled')).toBeTruthy();
    expect(screen.queryByTestId('signup-continue-apple-top')).toBeNull();
    fireEvent.changeText(screen.getByTestId('signup-phone'), '(415) 555-0100');
    fireEvent.press(screen.getByTestId('signup-residence-US'));
    await submitDetails();
    expect(s.api.start.mock.calls[0]![0]).toMatchObject({ email: APPLE.email, name: 'Pat Lee' });
    expect(await screen.findByTestId('signup-email-code')).toBeTruthy();
  });

  it('Apple shared no name: only the email is filled; a cancelled Apple sheet changes nothing', async () => {
    const appleIdentity = jest
      .fn()
      .mockRejectedValueOnce(clientError('auth_cancelled'))
      .mockResolvedValueOnce({ email: 'a@icloud.com', givenName: null, familyName: null });
    setup({ appleIdentity });
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-apple-top'));
    });
    expect(screen.queryByTestId('signup-failure')).toBeNull();
    expect(screen.getByTestId('signup-email').props.value).toBe('');
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-apple-top'));
    });
    expect(screen.getByTestId('signup-email').props.value).toBe('a@icloud.com');
    expect(screen.getByTestId('signup-name').props.value).toBe('');
  });

  it('an Apple-first signup ends with Continue with Apple only', async () => {
    const appleIdentity = jest.fn(async () => APPLE);
    const api = fakeApi();
    const s = setup({ api, appleIdentity });
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-apple-top'));
    });
    fireEvent.changeText(screen.getByTestId('signup-phone'), '(415) 555-0100');
    fireEvent.press(screen.getByTestId('signup-residence-US'));
    await submitDetails();
    await enterCode();
    expect(await screen.findByTestId('signup-accept')).toBeTruthy();
    fireEvent.press(screen.getByTestId('signup-accept'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-complete'));
    });
    expect(screen.getByTestId('signup-done-copy')).toHaveTextContent(SIGNUP_COPY.doneBodyApple);
    expect(screen.queryByTestId('signup-continue-google')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('signup-continue-apple'));
    });
    expect(s.signIn).toHaveBeenCalledWith('apple');
  });
});
