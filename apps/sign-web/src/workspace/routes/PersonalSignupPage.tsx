import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Btn, Check, ErrorBox, Field, fieldErrorId, Loading, Sel, TextIn } from '../ui';

import {
  codeFailureMessage,
  COUNTRIES,
  documentLabel,
  fetchPersonalTerms,
  LOCATION_MESSAGE,
  NOT_OPEN_MESSAGE,
  personalPost,
  startFailure,
  toE164,
  turnstileSiteKey,
  type CompleteResponse,
  type Held,
  type Country,
  type NextStep,
  type PersonalSignupError,
  type StartFailure,
  type TermsDocument,
} from './personal-signup-api';
import { Turnstile } from './Turnstile';

// Aramo Sign Personal (Free) — /signup/personal, session-less
// (Aramo-Sign-Personal-Free-Launch-Directive-v1_1 §3):
//   form → email code → [phone code, only when the backend says so] → terms →
//   done (Continue with Google for exactly the verified email). A `review` or an
//   unverifiable `step_up` still creates the account (§6.3) — the done screen then
//   says what sending waits for; only an explicit refusal ends on the review
//   screen. Every decision (eligibility, risk, next step, approved documents) is
//   the backend's; this page only renders it. Nothing activates until the Google
//   identity for the verified email signs in (§3.6).

export const RESEND_SECONDS = 60;
const SUPPORT_URL = 'https://aramo.ai/company/contact.html?route=Aramo%20Sign';

const HELD_NOTE: Record<Exclude<Held, null>, string> = {
  review: 'Your account is being reviewed. You can sign in, but sending is paused until the review is done (usually within 1 business day).',
  phone_verification_required:
    'To send documents you’ll need to verify your phone. Phone verification is temporarily unavailable — we’ll let you know when it’s ready.',
};

type Step =
  | { k: 'form' }
  | { k: 'email'; id: string }
  | { k: 'phone'; id: string }
  | { k: 'terms'; id: string; hint: Held; notice?: string }
  | { k: 'review' }
  | { k: 'done'; google: string | null; held: Held };

function Frame({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  const h = useRef<HTMLHeadingElement | null>(null);
  // Each step is a new screen: move focus to its heading so screen readers announce it.
  useEffect(() => {
    h.current?.focus();
  }, [title]);
  return (
    <div className="sg sg-center" data-testid={testId}>
      <main className="sg-state" style={{ maxWidth: 480, width: '100%', textAlign: 'left' }}>
        <div className="sg-state__mark" aria-hidden="true">
          S
        </div>
        <h1 className="sg-h1" ref={h} tabIndex={-1}>
          {title}
        </h1>
        {children}
      </main>
    </div>
  );
}

export function PersonalSignupPage({ siteKey = turnstileSiteKey() }: { siteKey?: string | null }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>({ k: 'form' });
  const [email, setEmail] = useState('');

  useEffect(() => {
    fetchPersonalTerms()
      .then((t) => setOpen(!t.off))
      // A network failure does not prove the mode is off; the form's own submit will tell.
      .catch(() => setOpen(true));
  }, []);

  if (open === null) return <Loading label="Loading…" />;
  if (!open) {
    return (
      <Frame title={NOT_OPEN_MESSAGE} testId="personal-not-open">
        <p className="sg-lede">
          Signing up for an organization? <a href="/signup">Create a business organization</a>.
        </p>
      </Frame>
    );
  }

  switch (step.k) {
    case 'form':
      return (
        <PersonalForm
          siteKey={siteKey}
          onStarted={(id, addr) => {
            setEmail(addr);
            setStep({ k: 'email', id });
          }}
          onNotOpen={() => setOpen(false)}
          onRefused={(addr) => {
            setEmail(addr);
            setStep({ k: 'review' });
          }}
        />
      );
    case 'email':
      return (
        <CodeStep
          key="email"
          testId="personal-email-code"
          title="Check your email"
          lede={
            <>
              We sent a 6-digit code to <strong>{email}</strong>. It works for 10 minutes.
            </>
          }
          verify={(code) => personalPost<{ next: NextStep }>('verify-email', { signup_id: step.id, code }).then((r) => r.next)}
          resend={() => personalPost<unknown>('resend-email', { signup_id: step.id }).then(() => true)}
          onNext={(next) => setStep(next === 'phone' ? { k: 'phone', id: step.id } : { k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null })}
          onRestart={() => setStep({ k: 'form' })}
        />
      );
    case 'phone':
      return (
        <PhoneStep
          id={step.id}
          onNext={(next) => setStep({ k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null })}
          onUnavailable={() =>
            // §6.3 — the account is still created; sending waits for phone assurance.
            setStep({
              k: 'terms',
              id: step.id,
              hint: 'phone_verification_required',
              notice: 'Phone verification is temporarily unavailable. You can still create your account.',
            })
          }
          onRestart={() => setStep({ k: 'form' })}
        />
      );
    case 'terms': {
      const hint = step.hint;
      return (
        <TermsStep
          id={step.id}
          {...(step.notice !== undefined ? { notice: step.notice } : {})}
          onDone={(google, held) => setStep({ k: 'done', google, held: held === undefined ? hint : held })}
          onRestart={() => setStep({ k: 'form' })}
        />
      );
    }
    case 'review':
      return (
        <Frame title="We’re reviewing your account…" testId="personal-review">
          <p className="sg-lede">
            Thanks. We review some new signups before an account can be created. If your details can be used, we’ll email you at <strong>{email}</strong>.
          </p>
          <p className="sg-help">
            Questions? <a href={SUPPORT_URL}>Contact Aramo support</a>.
          </p>
        </Frame>
      );
    case 'done':
      return (
        <Frame title="Your personal account is ready" testId="personal-done">
          <p className="sg-lede" data-testid="personal-done-copy">
            Sign in with the Google account for <strong>{email}</strong>. No Google account for this address? You can create one with this email.
          </p>
          <p className="sg-help">Your account stays inactive until you sign in with that Google account.</p>
          {/@(gmail|googlemail)\.com$/i.test(email) ? (
            <p className="sg-help" data-testid="personal-done-gmail">
              Sign-in must match this address exactly. If Google shows your address with dots (for example pat.lee@gmail.com), it must be entered the same way here.
            </p>
          ) : null}
          {step.held !== null ? (
            <p className="sg-notice" role="status" data-testid="personal-held">
              {HELD_NOTE[step.held]}
            </p>
          ) : null}
          {step.google !== null ? (
            <a className="sg-btn sg-btn--primary sg-btn--block" href={step.google} data-testid="personal-signin-google">
              Continue with Google
            </a>
          ) : (
            <a className="sg-btn sg-btn--primary sg-btn--block" href="/login" data-testid="personal-signin">
              Sign in
            </a>
          )}
        </Frame>
      );
  }
}

// ── Step 1: the form ───────────────────────────────────────────────────────

type FieldKey = 'name' | 'email' | 'phone' | 'residence' | 'invite';
const FIELD_ID: Record<FieldKey, string> = { name: 'ps-name', email: 'ps-email', phone: 'ps-phone', residence: 'ps-residence', invite: 'ps-invite' };

function inviteFromUrl(): string {
  const q = new URLSearchParams(window.location.search).get('invite');
  return q !== null ? q.trim() : '';
}

function PersonalForm({
  siteKey,
  onStarted,
  onNotOpen,
  onRefused,
}: {
  siteKey: string | null;
  onStarted: (id: string, email: string) => void;
  onNotOpen: () => void;
  onRefused: (email: string) => void;
}) {
  const startedAt = useRef(Date.now());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<Country>('US');
  const [phone, setPhone] = useState('');
  const [residence, setResidence] = useState<'' | Country>('');
  const [invite, setInvite] = useState(inviteFromUrl);
  const [showInvite, setShowInvite] = useState(() => inviteFromUrl() !== '');
  const [hp, setHp] = useState('');
  const [robot, setRobot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const focus = (k: FieldKey): void => {
    setTimeout(() => document.getElementById(FIELD_ID[k])?.focus(), 0);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Partial<Record<FieldKey, string>> = {};
    if (name.trim().length < 2) errs.name = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter your email address.';
    const e164 = toE164(country, phone);
    if (e164 === null) errs.phone = country === 'US' ? 'Enter a 10-digit US mobile number.' : 'Enter a 10-digit Indian mobile number.';
    if (residence === '') errs.residence = 'Choose where you live.';
    if (showInvite && invite.trim() === '') errs.invite = 'Enter your invite code.';
    setErrors(errs);
    const first = (Object.keys(FIELD_ID) as FieldKey[]).find((k) => errs[k] !== undefined);
    if (first !== undefined) {
      focus(first);
      return;
    }
    setBusy(true);
    setFailure(null);
    personalPost<{ signup_id: string }>('start', {
      name: name.trim(),
      email: email.trim(),
      phone: e164,
      residence,
      robot_token: siteKey === null ? null : robot,
      ...(invite.trim() !== '' ? { invite_code: invite.trim() } : {}),
      hp,
      elapsed_ms: Date.now() - startedAt.current,
    })
      .then((r) => onStarted(r.signup_id, email.trim()))
      .catch((err: PersonalSignupError) => {
        const f = startFailure(err);
        if (f.kind === 'not_open') {
          onNotOpen();
        } else if (f.kind === 'refused') {
          // Neutral, non-enumerating: an explicit refusal shows the review screen.
          onRefused(email.trim());
        } else if (f.kind === 'invite_required' || f.kind === 'invite_invalid') {
          setShowInvite(true);
          setErrors({ invite: f.kind === 'invite_required' ? 'Personal accounts are invite-only right now. Enter your invite code.' : 'This invite code isn’t valid for this email, or it has expired.' });
          focus('invite');
        } else if (f.kind === 'field' && (Object.keys(FIELD_ID) as string[]).includes(f.field)) {
          setErrors({ [f.field]: f.message });
          focus(f.field as FieldKey);
        } else {
          setFailure(f);
        }
      })
      .finally(() => setBusy(false));
  };

  const aria = (k: FieldKey) => (errors[k] !== undefined ? { 'aria-invalid': true as const, 'aria-describedby': fieldErrorId(FIELD_ID[k]) } : {});
  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? '';

  return (
    <Frame title="Create your free personal account" testId="personal-form">
      <section className="sg-card" style={{ margin: '4px 0 16px' }} aria-label="Plan" data-testid="personal-plan">
        <div className="sg-card__body">
          <div style={{ fontWeight: 700 }}>Free</div>
          <div className="sg-lede">5 E-Signs a month, 2 a day, single user. Available in the United States and India.</div>
        </div>
      </section>
      <form className="sg-grid" style={{ gap: 12 }} onSubmit={submit} noValidate>
        <Field label="Full name" htmlFor="ps-name" error={errors.name}>
          <TextIn id="ps-name" required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} {...aria('name')} />
        </Field>
        <Field label="Personal email" htmlFor="ps-email" help="Gmail, Outlook.com, Yahoo and similar. You’ll sign in with Google for this address." error={errors.email}>
          <TextIn id="ps-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...aria('email')} />
        </Field>
        <div className="sg-field">
          <label className="sg-label" htmlFor="ps-phone">
            Mobile phone
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Sel aria-label="Phone country" value={country} onChange={(e) => setCountry(e.target.value as Country)} style={{ width: 'auto' }} data-testid="personal-phone-country">
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.dial})
                </option>
              ))}
            </Sel>
            <TextIn
              id="ps-phone"
              type="tel"
              inputMode="tel"
              required
              autoComplete="tel-national"
              placeholder={dial === '+1' ? '(555) 123-4567' : '98765 43210'}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
              {...aria('phone')}
            />
          </div>
          <div className="sg-help">Used only to verify your account and keep it secure — never for marketing.</div>
          {errors.phone !== undefined ? (
            <div className="sg-field-error" id={fieldErrorId('ps-phone')}>
              {errors.phone}
            </div>
          ) : null}
        </div>
        <Field label="Where do you live?" htmlFor="ps-residence" error={errors.residence}>
          <Sel id="ps-residence" required value={residence} onChange={(e) => setResidence(e.target.value as '' | Country)} {...aria('residence')}>
            <option value="">Choose…</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Sel>
        </Field>
        {showInvite ? (
          <Field label="Invite code" htmlFor="ps-invite" error={errors.invite}>
            <TextIn id="ps-invite" autoComplete="off" value={invite} onChange={(e) => setInvite(e.target.value)} {...aria('invite')} />
          </Field>
        ) : null}
        {/* Honeypot (§6.1): invisible to people, filled only by form robots. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor="ps-website">Website</label>
          <TextIn id="ps-website" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} data-testid="personal-hp" />
        </div>
        <Turnstile siteKey={siteKey} onToken={setRobot} />
        {failure !== null ? <FailureBox f={failure} /> : null}
        <Btn variant="primary" type="submit" disabled={busy || (siteKey !== null && robot === null)} data-testid="personal-submit">
          {busy ? 'Sending code…' : 'Continue'}
        </Btn>
        {siteKey !== null && robot === null ? <p className="sg-help">Complete the security check to continue.</p> : null}
        <p className="sg-help">
          Signing up for a company? <a href="/signup">Create a business organization</a>. Already have an account? <a href="/login">Sign in</a>
        </p>
      </form>
    </Frame>
  );
}

function FailureBox({ f }: { f: StartFailure }) {
  switch (f.kind) {
    case 'business_email':
      return (
        <ErrorBox>
          <span data-testid="personal-error-business">
            This looks like a work email. <a href="/signup">Create a business organization</a> instead, or use your personal email.
          </span>
        </ErrorBox>
      );
    case 'disposable':
      return (
        <ErrorBox>
          <span data-testid="personal-error-disposable">Temporary or disposable email addresses can’t be used. Use your personal email address.</span>
        </ErrorBox>
      );
    case 'location':
      return (
        <ErrorBox>
          <span data-testid="personal-error-location">{LOCATION_MESSAGE}</span>
        </ErrorBox>
      );
    case 'rate_limited':
      return <ErrorBox>Too many attempts. Wait a few minutes and try again.</ErrorBox>;
    case 'field':
    case 'other':
      return <ErrorBox>{f.message}</ErrorBox>;
    default:
      return <ErrorBox>Something went wrong. Try again.</ErrorBox>;
  }
}

// ── One-time code screens ──────────────────────────────────────────────────

function useCountdown(seconds: number): [number, () => void] {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(seconds)];
}

function CodeStep({
  testId,
  title,
  lede,
  verify,
  resend,
  onNext,
  onRestart,
}: {
  testId: string;
  title: string;
  lede: ReactNode;
  verify: (code: string) => Promise<NextStep>;
  resend: () => Promise<boolean>;
  onNext: (next: NextStep) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [left, resetTimer] = useCountdown(RESEND_SECONDS);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    verify(code)
      .then(onNext)
      .catch((err: PersonalSignupError) => {
        const f = codeFailureMessage(err);
        setError(f.message);
        setRestart(f.restart);
        setCode('');
      })
      .finally(() => setBusy(false));
  };

  const again = () => {
    setError(null);
    setNotice(null);
    resend()
      .then((ok) => {
        if (ok) {
          setNotice('We sent a new code.');
          resetTimer();
        }
      })
      .catch((err: PersonalSignupError) => {
        const f = codeFailureMessage(err);
        setError(err.status === 429 ? 'You’ve asked for too many codes. Try again later.' : f.message);
        setRestart(f.restart);
      });
  };

  return (
    <Frame title={title} testId={testId}>
      <p className="sg-lede">{lede}</p>
      <form className="sg-grid" style={{ gap: 12, marginTop: 12 }} onSubmit={submit} noValidate>
        <Field label="6-digit code" htmlFor={`${testId}-input`} error={error ?? undefined}>
          <TextIn
            id={`${testId}-input`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            {...(error !== null ? { 'aria-invalid': true as const, 'aria-describedby': fieldErrorId(`${testId}-input`) } : {})}
            data-testid="code-input"
          />
        </Field>
        {notice !== null ? (
          <p className="sg-help" role="status">
            {notice}
          </p>
        ) : null}
        {restart ? (
          <Btn variant="primary" type="button" onClick={onRestart} data-testid="code-restart">
            Start again
          </Btn>
        ) : (
          <Btn variant="primary" type="submit" disabled={busy || code.length !== 6} data-testid="code-submit">
            {busy ? 'Checking…' : 'Verify'}
          </Btn>
        )}
        {!restart ? (
          <Btn type="button" onClick={again} disabled={left > 0} data-testid="code-resend" aria-live="polite">
            {left > 0 ? `Send a new code in ${left}s` : 'Send a new code'}
          </Btn>
        ) : null}
      </form>
    </Frame>
  );
}

function PhoneStep({ id, onNext, onUnavailable, onRestart }: { id: string; onNext: (next: NextStep) => void; onUnavailable: () => void; onRestart: () => void }) {
  const [sent, setSent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    // One send per screen (React StrictMode runs effects twice in development).
    if (once.current) return;
    once.current = true;
    personalPost<{ sent: boolean }>('phone/send', { signup_id: id })
      .then((r) => {
        if (r.sent) setSent(true);
        else onUnavailable();
      })
      .catch((err: PersonalSignupError) => setError(codeFailureMessage(err).message));
  }, [id, onUnavailable]);

  if (error !== null) {
    return (
      <Frame title="We couldn’t send a code to your phone" testId="personal-phone-error">
        <ErrorBox>{error}</ErrorBox>
        <div style={{ marginTop: 12 }}>
          <Btn variant="primary" onClick={onRestart}>
            Start again
          </Btn>
        </div>
      </Frame>
    );
  }
  if (sent === null) return <Loading label="Sending a code to your phone…" />;
  return (
    <CodeStep
      testId="personal-phone-code"
      title="Verify your mobile phone"
      lede="We sent a 6-digit code by text message to your mobile phone. It works for 10 minutes."
      verify={(code) => personalPost<{ next?: NextStep }>('phone/verify', { signup_id: id, code }).then((r) => (r.next === 'review' ? 'review' : 'terms'))}
      resend={() => personalPost<{ sent: boolean }>('phone/send', { signup_id: id }).then((r) => {
        if (!r.sent) onUnavailable();
        return r.sent;
      })}
      onNext={onNext}
      onRestart={onRestart}
    />
  );
}

// ── Legal acceptance (§3.4) ────────────────────────────────────────────────

function TermsStep({
  id,
  notice,
  onDone,
  onRestart,
}: {
  id: string;
  notice?: string;
  onDone: (google: string | null, held: Held | undefined) => void;
  onRestart: () => void;
}) {
  const [docs, setDocs] = useState<TermsDocument[] | null | undefined>(undefined);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    fetchPersonalTerms()
      .then((t) => setDocs(t.off ? null : t.documents))
      .catch(() => setError('We couldn’t load the terms. Try again.'));
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (docs === null || docs === undefined || !agreed) return;
    setBusy(true);
    setError(null);
    personalPost<CompleteResponse>('complete', { signup_id: id, accept: docs.map((d) => ({ key: d.key, version: d.version })) })
      .then((r) => {
        if (r.status === 'PROVISIONED') onDone(typeof r.sign_in?.google === 'string' ? r.sign_in.google : null, r.held);
        else setError('Your account is still being created. Try again in a moment.');
      })
      .catch((err: PersonalSignupError) => {
        if (err.reason === 'legal_documents_not_approved') return setDocs(null);
        if (err.status === 404) return setExpired(true);
        setError(err.message);
      })
      .finally(() => setBusy(false));
  };

  if (expired) {
    return (
      <Frame title="This signup has expired" testId="personal-expired">
        <Btn variant="primary" onClick={onRestart}>
          Start again
        </Btn>
      </Frame>
    );
  }
  if (docs === undefined && error === null) return <Loading label="Loading the terms…" />;
  if (docs === null) {
    return (
      <Frame title={NOT_OPEN_MESSAGE} testId="personal-terms-unavailable">
        <p className="sg-lede">Your email is confirmed, but we can’t create personal accounts yet. Please try again later.</p>
      </Frame>
    );
  }
  return (
    <Frame title="Review and accept" testId="personal-terms">
      {notice !== undefined ? (
        <p className="sg-notice" role="status" data-testid="personal-phone-unavailable">
          {notice}
        </p>
      ) : null}
      <p className="sg-lede">Read these documents before you create your account.</p>
      <form className="sg-grid" style={{ gap: 12, marginTop: 12 }} onSubmit={submit}>
        <ul data-testid="personal-terms-docs" style={{ margin: 0, paddingLeft: 18 }}>
          {(docs ?? []).map((d) => (
            <li key={d.key}>
              <a href={d.url} target="_blank" rel="noopener noreferrer">
                {documentLabel(d.key)}
              </a>{' '}
              <span className="sg-muted">(version {d.version})</span>
            </li>
          ))}
        </ul>
        <label className="sg-settings-row" htmlFor="ps-accept">
          <Check id="ps-accept" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="personal-accept" />
          <span>I have read and agree to the documents above.</span>
        </label>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <Btn variant="primary" type="submit" disabled={busy || !agreed || docs === undefined} data-testid="personal-complete">
          {busy ? 'Creating your account…' : 'Create my account'}
        </Btn>
      </form>
    </Frame>
  );
}
