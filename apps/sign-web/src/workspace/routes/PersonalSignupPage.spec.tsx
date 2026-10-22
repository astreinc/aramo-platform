import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

import { PersonalSignupPage } from './PersonalSignupPage';
import { codeFailureMessage, startFailure, toE164 } from './personal-signup-api';

// Aramo Sign Personal (Free) — /signup/personal: public, dark while the mode is
// off, every refusal reason rendered, the backend decides the next step, the
// terms checkbox is never preselected, Turnstile only when configured.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status: number, reason: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code: 'VALIDATION_ERROR', message: `refused: ${reason}`, details: { reason, ...extra } } }, status);

const DOCS = [
  { key: 'sign.personal_terms_of_service', version: '1.0', url: 'https://aramo.ai/legal/personal-terms', sha256: 'a'.repeat(64) },
  { key: 'aramo.privacy_notice', version: '1.0', url: 'https://aramo.ai/legal/privacy', sha256: 'b'.repeat(64) },
  { key: 'aramo.acceptable_use_policy', version: '1.0', url: 'https://aramo.ai/legal/aup', sha256: 'c'.repeat(64) },
];
const GOOGLE = 'https://sign.example.test/auth/sign/login?idp=google&return_to=%2F';

type Handler = (body: Record<string, unknown>) => Response;
function api(routes: Record<string, Handler | Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^.*\/v1\/signup\/sign\/personal\//, '');
    const r = url.includes('/v1/signup/sign/personal/') ? routes[path] : undefined;
    if (r === undefined) return url.endsWith('/personal/terms') ? json({ documents: DOCS }) : json({}, 401);
    if (r instanceof Response) return r.clone();
    return r(init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
  });
}

function at(fetch: ReturnType<typeof api>, path = '/signup/personal') {
  vi.stubGlobal('fetch', fetch);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function fillForm({ email = 'pat@gmail.com', phone = '(415) 555-0134', country = 'US', residence = 'US' } = {}) {
  fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Pat Lee' } });
  fireEvent.change(screen.getByLabelText('Personal email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Phone country'), { target: { value: country } });
  fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText('Country of residence'), { target: { value: residence } });
}

const bodyOf = (fetch: ReturnType<typeof api>, path: string) => {
  const call = fetch.mock.calls.find(([u]) => String(u).endsWith(`/personal/${path}`));
  return call === undefined ? undefined : (JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
};

async function toEmailCode(fetch: ReturnType<typeof api>) {
  at(fetch);
  await fillForm();
  fireEvent.click(screen.getByTestId('personal-submit'));
  await screen.findByTestId('personal-email-code');
}

function enterCode(code = '123456') {
  fireEvent.change(screen.getByTestId('code-input'), { target: { value: code } });
  fireEvent.click(screen.getByTestId('code-submit'));
}

describe('/signup/personal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    document.getElementById('sg-turnstile')?.remove();
    delete window.turnstile;
    window.history.replaceState(null, '', '/');
  });

  it('is dark while the Personal mode is off (terms 404)', async () => {
    at(api({ terms: json({}, 404) }));
    const page = await screen.findByTestId('personal-not-open');
    expect(page).toHaveTextContent('Personal accounts aren’t open yet');
    expect(within(page).getByRole('link', { name: 'Create a Business account' })).toHaveAttribute('href', '/signup');
    expect(screen.queryByTestId('personal-form')).toBeNull();
  });

  it('details step in the activation layout; phone and residence offer only the United States and India', async () => {
    at(api({}));
    expect(await screen.findByRole('heading', { name: 'Tell us about you' })).toBeInTheDocument();
    expect(screen.getByTestId('personal-form')).toHaveTextContent('For your free personal account. 5 documents a month.');
    const nav = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(nav).getByTestId('step-form')).toHaveAttribute('aria-current', 'step');
    // Verify phone is listed only once the backend asks for it.
    expect(within(nav).queryByTestId('step-phone')).toBeNull();
    const phoneOpts = within(screen.getByLabelText('Phone country')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(phoneOpts).toEqual(['US', 'IN']);
    const resOpts = within(screen.getByLabelText('Country of residence')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(resOpts).toEqual(['', 'US', 'IN', 'OTHER']);
    // The Privacy Notice at the point of collection, and the GeoLite2 attribution.
    expect(screen.getByTestId('personal-privacy-notice')).toHaveTextContent('We use your details as described in our Privacy Notice.');
    const privacy = within(screen.getByTestId('personal-privacy-notice')).getByRole('link', { name: 'Privacy Notice' });
    expect(privacy).toHaveAttribute('href', '/legal/privacy/1.0');
    expect(privacy).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('personal-maxmind')).toHaveTextContent('This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.');
    expect(within(screen.getByTestId('personal-maxmind')).getByRole('link', { name: 'https://www.maxmind.com' })).toHaveAttribute('href', 'https://www.maxmind.com');
    expect(within(screen.getByTestId('personal-maxmind')).getByRole('link', { name: 'Third-party notices' })).toHaveAttribute('href', '/legal/third-party-notices');
    // No Turnstile without a site key, and no script from Cloudflare.
    expect(screen.queryByTestId('turnstile')).toBeNull();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });

  it('posts the form with E.164 phone, honeypot, elapsed time and a null robot token, then asks for the email code', async () => {
    const fetch = api({ start: json({ signup_id: 'su-1' }, 202) });
    at(fetch);
    await fillForm({ country: 'IN', phone: '098765 43210', residence: 'IN' });
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByTestId('personal-email-code')).toHaveTextContent('pat@gmail.com');
    const body = bodyOf(fetch, 'start')!;
    expect(body).toMatchObject({ name: 'Pat Lee', email: 'pat@gmail.com', phone: '+919876543210', residence: 'IN', robot_token: null, hp: '' });
    expect(typeof body['elapsed_ms']).toBe('number');
    expect(body).not.toHaveProperty('invite_code');
  });

  it('another country of residence is refused here, with the Business route, and never sent', async () => {
    const fetch = api({});
    at(fetch);
    await fillForm({ residence: 'OTHER' });
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByText('Personal accounts are available in the US and India only.')).toBeInTheDocument();
    expect(within(screen.getByTestId('personal-region')).getByRole('link', { name: 'create a Business account' })).toHaveAttribute('href', '/signup');
    expect(bodyOf(fetch, 'start')).toBeUndefined();
  });

  it('validates the form before sending anything', async () => {
    const fetch = api({});
    at(fetch);
    fireEvent.click(await screen.findByTestId('personal-submit'));
    expect(await screen.findByText('Enter your full name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a 10-digit US mobile number.')).toBeInTheDocument();
    expect(screen.getByText('Choose where you live.')).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toHaveAttribute('aria-invalid', 'true');
    expect(bodyOf(fetch, 'start')).toBeUndefined();
  });

  it.each([
    ['business_email_use_business_signup', 'personal-error-business', 'work email'],
    ['personal_email_not_allowed', 'personal-error-disposable', 'Disposable email addresses aren’t allowed'],
    ['personal_location_not_supported', 'personal-error-location', 'currently available in the United States and India'],
  ])('renders the %s refusal', async (reason, testId, text) => {
    at(api({ start: refusal(400, reason) }));
    await fillForm();
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByTestId(testId)).toHaveTextContent(text);
  });

  it('the business-email refusal links to business signup', async () => {
    at(api({ start: refusal(400, 'business_email_use_business_signup') }));
    await fillForm({ email: 'pat@astre.test' });
    fireEvent.click(screen.getByTestId('personal-submit'));
    const box = await screen.findByTestId('personal-error-business');
    expect(within(box).getByRole('link')).toHaveAttribute('href', '/signup');
  });

  it('invite mode: asks for a code when required, flags an invalid one, and sends it', async () => {
    let n = 0;
    const fetch = api({
      start: (b) => {
        n += 1;
        if (n === 1) return refusal(400, 'personal_invite_required');
        if (b['invite_code'] !== 'GOOD-CODE') return refusal(400, 'personal_invite_invalid');
        return json({ signup_id: 'su-1' }, 202);
      },
    });
    at(fetch);
    await fillForm();
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByText('Personal accounts are invite-only right now. Enter your invite code.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'BAD' } });
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByText('This invite code isn’t valid for this email, or it has expired.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'GOOD-CODE' } });
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByTestId('personal-email-code')).toBeInTheDocument();
  });

  it('a start that answers 404 (mode switched off) shows the not-open page', async () => {
    at(api({ start: json({}, 404) }));
    await fillForm();
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByTestId('personal-not-open')).toBeInTheDocument();
  });

  it('email code: resend waits 60 seconds; a wrong code shows tries left; terms → done with Continue with Google', async () => {
    let tries = 0;
    const fetch = api({
      start: json({ signup_id: 'su-1' }, 202),
      'verify-email': (b) => {
        tries += 1;
        return tries === 1 ? refusal(400, 'code_invalid', { attempts_remaining: 4 }) : json({ next: b['code'] === '654321' ? 'terms' : 'review' });
      },
      complete: json({ status: 'PROVISIONED', sign_in: { google: GOOGLE } }),
    });
    await toEmailCode(fetch);
    const resend = screen.getByTestId('code-resend');
    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent('Resend in 1:00');
    // One labelled input carries the code; the six boxes are hidden from screen readers.
    expect(screen.getByLabelText('6-digit code')).toBe(screen.getByTestId('code-input'));
    expect(screen.getByTestId('code-input')).toHaveAttribute('autocomplete', 'one-time-code');
    enterCode('111111');
    expect(await screen.findByText('That code isn’t right. 4 tries left.')).toBeInTheDocument();
    enterCode('654321');
    expect(await screen.findByTestId('personal-terms')).toBeInTheDocument();
    expect(bodyOf(fetch, 'verify-email')).toEqual({ signup_id: 'su-1', code: '111111' });
    const docs = within(screen.getByTestId('personal-terms-docs')).getAllByRole('link');
    expect(docs.map((a) => a.getAttribute('href'))).toEqual(DOCS.map((d) => d.url));
    expect(screen.getByTestId('personal-terms-docs')).toHaveTextContent('v1.0');
    expect(screen.getByTestId('personal-plan')).toHaveTextContent('5 documents a month · up to 2 a day');
    const box = screen.getByTestId('personal-accept') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('personal-complete')).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('personal-complete'));
    expect(await screen.findByTestId('personal-done')).toBeInTheDocument();
    expect(screen.getByTestId('personal-done-copy')).toHaveTextContent(
      'Sign in with the Google account for pat@gmail.com. No Google account for this address? You can create one with this email.',
    );
    expect(screen.getByTestId('personal-done-gmail')).toHaveTextContent('Sign-in must match this address exactly.');
    expect(screen.getByTestId('personal-signin-google')).toHaveAttribute('href', GOOGLE);
    expect(bodyOf(fetch, 'complete')).toEqual({ signup_id: 'su-1', accept: DOCS.map((d) => ({ key: d.key, version: d.version })) });
  });

  it('too many wrong email codes offers Start again', async () => {
    await toEmailCode(api({ start: json({ signup_id: 'su-1' }, 202), 'verify-email': refusal(400, 'otp_attempts_exceeded') }));
    enterCode();
    expect(await screen.findByTestId('code-restart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Too many tries' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('code-restart'));
    expect(await screen.findByTestId('personal-form')).toBeInTheDocument();
  });

  it('an explicit personal_signup_refused shows the neutral review screen', async () => {
    at(api({ start: refusal(400, 'personal_signup_refused') }));
    await fillForm();
    fireEvent.click(screen.getByTestId('personal-submit'));
    expect(await screen.findByTestId('personal-review')).toHaveTextContent('We’re reviewing your account…');
    expect(screen.getByTestId('personal-review')).toHaveTextContent('pat@gmail.com');
  });

  async function acceptAndComplete() {
    fireEvent.click(await screen.findByTestId('personal-accept'));
    fireEvent.click(screen.getByTestId('personal-complete'));
    return screen.findByTestId('personal-done');
  }

  it('next=review still creates the account: terms → complete → done with the review note', async () => {
    const fetch = api({
      start: json({ signup_id: 'su-1' }, 202),
      'verify-email': json({ next: 'review' }),
      complete: json({ status: 'PROVISIONED', held: 'review', sign_in: { google: GOOGLE } }),
    });
    await toEmailCode(fetch);
    enterCode();
    await acceptAndComplete();
    expect(bodyOf(fetch, 'complete')).toBeDefined();
    expect(screen.getByTestId('personal-signin-google')).toHaveAttribute('href', GOOGLE);
    expect(screen.getByTestId('personal-held')).toHaveTextContent(
      'Your account is being reviewed. You can sign in, but sending is paused until the review is done (usually within 1 business day).',
    );
  });

  it('next=phone with SMS unavailable (sent=false) continues to terms and completes with the phone note', async () => {
    const fetch = api({
      start: json({ signup_id: 'su-1' }, 202),
      'verify-email': json({ next: 'phone' }),
      'phone/send': json({ sent: false }),
      complete: json({ status: 'PROVISIONED', held: 'phone_verification_required', sign_in: { google: GOOGLE } }),
    });
    await toEmailCode(fetch);
    enterCode();
    expect(await screen.findByTestId('personal-phone-unavailable')).toHaveTextContent('Phone verification is temporarily unavailable.');
    expect(screen.getByTestId('personal-terms')).toBeInTheDocument();
    await acceptAndComplete();
    expect(bodyOf(fetch, 'phone/verify')).toBeUndefined();
    expect(screen.getByTestId('personal-held')).toHaveTextContent(
      'To send documents you’ll need to verify your phone. Phone verification is temporarily unavailable — we’ll let you know when it’s ready.',
    );
  });

  it('without a held field in the response, the step the backend revealed decides the note; held null shows none', async () => {
    await toEmailCode(api({ start: json({ signup_id: 'su-1' }, 202), 'verify-email': json({ next: 'review' }), complete: json({ status: 'PROVISIONED', sign_in: { google: GOOGLE } }) }));
    enterCode();
    await acceptAndComplete();
    expect(screen.getByTestId('personal-held')).toHaveTextContent('Your account is being reviewed.');
  });

  it('an allowed signup (held null) shows no held note', async () => {
    await toEmailCode(api({ start: json({ signup_id: 'su-1' }, 202), 'verify-email': json({ next: 'terms' }), complete: json({ status: 'PROVISIONED', held: null, sign_in: { google: GOOGLE } }) }));
    enterCode();
    await acceptAndComplete();
    expect(screen.queryByTestId('personal-held')).toBeNull();
  });

  it('next=phone with SMS sent verifies the phone code, then shows the terms', async () => {
    const fetch = api({
      start: json({ signup_id: 'su-1' }, 202),
      'verify-email': json({ next: 'phone' }),
      'phone/send': json({ sent: true }),
      'phone/verify': json({ next: 'terms' }),
    });
    await toEmailCode(fetch);
    enterCode();
    expect(await screen.findByTestId('personal-phone-code')).toHaveTextContent('We texted a 6-digit code to +1 ••• ••• 0134.');
    expect(screen.getByTestId('step-phone')).toHaveAttribute('aria-current', 'step');
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/phone/send'))).toHaveLength(1);
    enterCode('222222');
    expect(await screen.findByTestId('personal-terms')).toBeInTheDocument();
    expect(bodyOf(fetch, 'phone/verify')).toEqual({ signup_id: 'su-1', code: '222222' });
  });

  it('terms not yet approved (documents null) → not open; complete refused the same way', async () => {
    let termsCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/personal/terms')) {
        termsCalls += 1;
        return json({ documents: termsCalls === 1 ? DOCS : null });
      }
      if (url.endsWith('/personal/start')) return json({ signup_id: 'su-1' }, 202);
      if (url.endsWith('/personal/verify-email')) return json({ next: 'terms' });
      return json({}, 401);
    });
    vi.stubGlobal('fetch', fetch);
    render(
      <MemoryRouter initialEntries={['/signup/personal']}>
        <App />
      </MemoryRouter>,
    );
    await fillForm();
    fireEvent.click(screen.getByTestId('personal-submit'));
    await screen.findByTestId('personal-email-code');
    enterCode();
    expect(await screen.findByTestId('personal-terms-unavailable')).toHaveTextContent('Personal accounts aren’t open yet');
  });

  it('complete refused with legal_documents_not_approved shows not open', async () => {
    await toEmailCode(api({ start: json({ signup_id: 'su-1' }, 202), 'verify-email': json({ next: 'terms' }), complete: refusal(409, 'legal_documents_not_approved') }));
    enterCode();
    fireEvent.click(await screen.findByTestId('personal-accept'));
    fireEvent.click(screen.getByTestId('personal-complete'));
    expect(await screen.findByTestId('personal-terms-unavailable')).toBeInTheDocument();
  });

  it('with a Turnstile site key: loads the Cloudflare script, waits for the check, sends the token', async () => {
    window.turnstile = {
      render: (_el, opts) => {
        setTimeout(() => (opts['callback'] as (t: string) => void)('tok-123'), 0);
        return 'w1';
      },
      remove: vi.fn(),
    };
    const fetch = api({ start: json({ signup_id: 'su-1' }, 202) });
    vi.stubGlobal('fetch', fetch);
    render(<PersonalSignupPage siteKey="0x4AAA-site" />);
    expect(await screen.findByTestId('turnstile')).toBeInTheDocument();
    await fillForm();
    await waitFor(() => expect(screen.getByTestId('personal-submit')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('personal-submit'));
    await screen.findByTestId('personal-email-code');
    expect(bodyOf(fetch, 'start')?.['robot_token']).toBe('tok-123');
  });

  it('with a site key but no token yet, submit stays disabled and the script comes from challenges.cloudflare.com', async () => {
    vi.stubGlobal('fetch', api({}));
    render(<PersonalSignupPage siteKey="0x4AAA-site" />);
    await screen.findByTestId('turnstile');
    expect(screen.getByTestId('personal-submit')).toBeDisabled();
    const s = document.getElementById('sg-turnstile') as HTMLScriptElement | null;
    expect(s?.src.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')).toBe(true);
  });
});

describe('personal signup helpers', () => {
  it('toE164 accepts only valid US and Indian mobile numbers', () => {
    expect(toE164('US', '415-555-0134')).toBe('+14155550134');
    expect(toE164('US', '1 415 555 0134')).toBe('+14155550134');
    expect(toE164('US', '123')).toBeNull();
    expect(toE164('IN', '+91 98765 43210')).toBe('+919876543210');
    expect(toE164('IN', '12345 67890')).toBeNull();
  });

  it('maps refusal reasons and code failures', () => {
    const e = (status: number, reason?: string, details: Record<string, unknown> = {}) => ({ status, message: 'm', details, ...(reason !== undefined ? { reason } : {}) });
    expect(startFailure(e(400, 'personal_invite_invalid')).kind).toBe('invite_invalid');
    expect(startFailure(e(429)).kind).toBe('rate_limited');
    expect(startFailure(e(400, undefined, { field: 'email' })).kind).toBe('field');
    expect(codeFailureMessage(e(400, 'otp_expired')).message).toMatch(/expired/);
    // The stable reasons engineer A emits.
    expect(startFailure(e(400, 'invite_required')).kind).toBe('invite_required');
    expect(startFailure(e(400, 'invite_invalid')).kind).toBe('invite_invalid');
    expect(codeFailureMessage(e(400, 'code_expired')).message).toMatch(/expired/);
    expect(codeFailureMessage(e(400, 'code_attempts_exceeded')).restart).toBe(true);
    expect(codeFailureMessage(e(400, 'code_invalid', { attempts_remaining: 2 })).message).toBe('That code isn’t right. 2 tries left.');
    expect(codeFailureMessage(e(400, 'code_invalid', { attempts_remaining: 0 })).restart).toBe(true);
  });
});
