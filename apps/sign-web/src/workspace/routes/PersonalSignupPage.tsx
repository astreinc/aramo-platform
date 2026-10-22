import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { legalPath, MAXMIND_ATTRIBUTION, MAXMIND_URL, THIRD_PARTY_NOTICES_PATH } from '../legal/catalog';

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
import {
  ActivationShell,
  Alert,
  ariaFor,
  CodeBoxes,
  PrimaryBtn,
  ProviderLink,
  Resend,
  StateBlock,
  StepFooter,
  StepHead,
  SUPPORT_URL,
  SuCheck,
  SuField,
  SuIcon,
  SuInput,
  SuSelect,
  useCountdown,
  type StepGroupDef,
} from './signup-ui';
import { Turnstile } from './Turnstile';

// Aramo Sign Personal (Free) — /signup/personal, session-less
// (Aramo-Sign-Personal-Free-Launch-Directive-v1_1 §3):
//   details → email code (the mandatory 6-digit OTP, §3 step 2) → [phone code,
//   only when the backend says so] → terms → done (Continue with Google for
//   exactly the verified email). A `review` or an unverifiable `step_up` still
//   creates the account (§6.3) — the done screen then says what sending waits for;
//   only an explicit refusal ends on the review screen. Every decision
//   (eligibility, risk, next step, approved documents) is the backend's; this
//   page only renders it, in the activation layout of the signup handoff §4.5.
//   Nothing activates until the Google identity for the verified email signs in
//   (§3.6). All copy is placeholder (LEGAL_PENDING).

export { RESEND_SECONDS } from './signup-ui';

const HELD: Record<Exclude<Held, null>, { title: string; note: string }> = {
  review: {
    title: 'We’re reviewing your account',
    note: 'Your account is being reviewed. You can sign in, but sending is paused until the review is done (usually within 1 business day).',
  },
  phone_verification_required: {
    title: 'Sending needs a verified phone',
    note: 'To send documents you’ll need to verify your phone. Phone verification is temporarily unavailable — we’ll let you know when it’s ready.',
  },
};

type Step =
  | { k: 'form' }
  | { k: 'email'; id: string }
  | { k: 'phone'; id: string }
  | { k: 'terms'; id: string; hint: Held; notice?: string }
  | { k: 'review' }
  | { k: 'done'; google: string | null; held: Held };

function groups(withPhone: boolean): readonly StepGroupDef[] {
  return [
    {
      label: 'Set up your account',
      items: [
        { key: 'form', label: 'Your details' },
        { key: 'email', label: 'Verify email' },
        ...(withPhone ? [{ key: 'phone', label: 'Verify phone' }] : []),
      ],
    },
    { label: 'Review and activate', items: [{ key: 'terms', label: 'Terms' }] },
  ];
}

/** The Personal activation frame. Done steps are not revisitable: each is a backend step already taken. */
function Shell({
  step,
  withPhone,
  allDone,
  testId,
  children,
}: {
  step?: string;
  withPhone: boolean;
  allDone?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <ActivationShell
      {...(step !== undefined ? { groups: groups(withPhone), current: step } : {})}
      allDone={allDone === true}
      testId={testId}
    >
      {children}
    </ActivationShell>
  );
}

const maskPhone = (e164: string | null) => {
  if (e164 === null) return 'your mobile phone';
  const cc = e164.startsWith('+91') ? '+91' : '+1';
  return `${cc} ••• ••• ${e164.slice(-4)}`;
};

export function PersonalSignupPage({ siteKey = turnstileSiteKey() }: { siteKey?: string | null }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>({ k: 'form' });
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [withPhone, setWithPhone] = useState(false);

  useEffect(() => {
    fetchPersonalTerms()
      .then((t) => setOpen(!t.off))
      // A network failure does not prove the mode is off; the form's own submit will tell.
      .catch(() => setOpen(true));
  }, []);

  if (open === null) {
    return (
      <Shell withPhone={false} testId="personal-loading">
        <p className="su-hint" role="status">
          Loading…
        </p>
      </Shell>
    );
  }
  if (!open) {
    return (
      <Shell withPhone={false} testId="personal-not-open">
        <StateBlock
          heading="step"
          tone="grey"
          icon="clock"
          title={NOT_OPEN_MESSAGE}
          sub="Signing up for an organization? Create a Business account instead."
        >
          <div>
            <a className="su-btn su-btn--primary" href="/signup">
              Create a Business account
            </a>
          </div>
        </StateBlock>
      </Shell>
    );
  }

  const restart = () => {
    setWithPhone(false);
    setStep({ k: 'form' });
  };

  switch (step.k) {
    case 'form':
      return (
        <Shell step="form" withPhone={withPhone} testId="personal-form">
          <PersonalForm
            siteKey={siteKey}
            onStarted={(id, addr, e164) => {
              setEmail(addr);
              setPhone(e164);
              setStep({ k: 'email', id });
            }}
            onNotOpen={() => setOpen(false)}
            onRefused={(addr) => {
              setEmail(addr);
              setStep({ k: 'review' });
            }}
          />
        </Shell>
      );
    case 'email':
      return (
        <Shell step="email" withPhone={withPhone} testId="personal-email-code">
          <CodeStep
            key="email"
            id="personal-email-code-input"
            title="Check your email"
            sub={
              <>
                We sent a 6-digit code to <strong>{email}</strong>. It works for 10 minutes.
              </>
            }
            submitLabel="Verify email"
            verify={(code) =>
              personalPost<{ next: NextStep }>('verify-email', { signup_id: step.id, code }).then(
                (r) => r.next,
              )
            }
            resend={() =>
              personalPost<unknown>('resend-email', { signup_id: step.id }).then(() => true)
            }
            onNext={(next) => {
              if (next === 'phone') {
                setWithPhone(true);
                setStep({ k: 'phone', id: step.id });
              } else
                setStep({ k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null });
            }}
            onRestart={restart}
          />
        </Shell>
      );
    case 'phone':
      return (
        <Shell step="phone" withPhone testId="personal-phone">
          <PhoneStep
            id={step.id}
            masked={maskPhone(phone)}
            onNext={(next) =>
              setStep({ k: 'terms', id: step.id, hint: next === 'review' ? 'review' : null })
            }
            onUnavailable={() =>
              // §6.3 — the account is still created; sending waits for phone assurance.
              setStep({
                k: 'terms',
                id: step.id,
                hint: 'phone_verification_required',
                notice:
                  'Phone verification is temporarily unavailable. You can still create your account.',
              })
            }
            onRestart={restart}
          />
        </Shell>
      );
    case 'terms': {
      const hint = step.hint;
      return (
        <TermsStep
          id={step.id}
          withPhone={withPhone}
          {...(step.notice !== undefined ? { notice: step.notice } : {})}
          onDone={(google, held) =>
            setStep({ k: 'done', google, held: held === undefined ? hint : held })
          }
          onRestart={restart}
        />
      );
    }
    case 'review':
      return (
        <Shell withPhone={false} testId="personal-review">
          <StateBlock
            heading="step"
            tone="grey"
            icon="person"
            title="We’re reviewing your account…"
            sub={
              <>
                Thanks. We review some new signups before an account can be created. If your details
                can be used, we’ll email you at <strong>{email}</strong>.
              </>
            }
          >
            <p className="su-hint">
              Questions?{' '}
              <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
                Contact Aramo support
              </a>
              .
            </p>
          </StateBlock>
        </Shell>
      );
    case 'done':
      return (
        <Shell step="terms" withPhone={withPhone} allDone testId="personal-done">
          <span className="su-tile su-tile--green" aria-hidden="true">
            <SuIcon name="check" />
          </span>
          <StepHead
            title="Your personal account is ready"
            sub="Sign in with Google to start using it. You can send up to 5 documents a month."
          />
          {step.held !== null ? (
            <div className="su-banner" role="status" data-testid="personal-held">
              <span className="su-banner__icon">
                <SuIcon name="info" size={18} />
              </span>
              <span>
                <b>{HELD[step.held].title}</b>
                {HELD[step.held].note}
              </span>
            </div>
          ) : null}
          <p className="su-hint" style={{ fontSize: 14 }} data-testid="personal-done-copy">
            Sign in with the Google account for <strong>{email}</strong>. No Google account for this
            address? You can create one with this email.
          </p>
          <div style={{ maxWidth: 360 }}>
            {step.google !== null ? (
              <ProviderLink provider="google" href={step.google} testId="personal-signin-google" />
            ) : (
              <a className="su-btn su-btn--primary" href="/login" data-testid="personal-signin">
                Sign in
              </a>
            )}
          </div>
          <div className="su-info">
            <b>Next time</b> · Your account stays inactive until you sign in with that Google
            account.
            {/@(gmail|googlemail)\.com$/i.test(email) ? (
              <span data-testid="personal-done-gmail">
                {' '}
                Sign-in must match this address exactly. If Google shows your address with dots (for
                example pat.lee@gmail.com), it must be entered the same way here.
              </span>
            ) : null}
          </div>
        </Shell>
      );
  }
}

// ── Step 1: your details ───────────────────────────────────────────────────

type FieldKey = 'name' | 'email' | 'phone' | 'residence' | 'invite';
const FIELD_ID: Record<FieldKey, string> = {
  name: 'ps-name',
  email: 'ps-email',
  phone: 'ps-phone',
  residence: 'ps-residence',
  invite: 'ps-invite',
};

/** Residence choices: the two offered countries (§6.6) plus "another country", which is refused here and never sent. */
type Residence = '' | Country | 'OTHER';
const REGION_MESSAGE = 'Personal accounts are available in the US and India only.';

function inviteFromUrl(): string {
  const q = new URLSearchParams(window.location.search).get('invite');
  return q !== null ? q.trim() : '';
}

const FLAG: Record<Country, string> = { US: '🇺🇸', IN: '🇮🇳' };

function PersonalForm({
  siteKey,
  onStarted,
  onNotOpen,
  onRefused,
}: {
  siteKey: string | null;
  onStarted: (id: string, email: string, phone: string | null) => void;
  onNotOpen: () => void;
  onRefused: (email: string) => void;
}) {
  const startedAt = useRef(Date.now());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<Country>('US');
  const [phone, setPhone] = useState('');
  const [residence, setResidence] = useState<Residence>('');
  const [invite, setInvite] = useState(inviteFromUrl);
  const [inviteRequired, setInviteRequired] = useState(false);
  const [hp, setHp] = useState('');
  const [robot, setRobot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const focus = (k: FieldKey): void => {
    setTimeout(() => document.getElementById(FIELD_ID[k])?.focus(), 0);
  };
  const edit = (k: FieldKey) =>
    setErrors((p) => {
      if (p[k] === undefined) return p;
      const n = { ...p };
      delete n[k];
      return n;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Partial<Record<FieldKey, string>> = {};
    if (name.trim().length < 2) errs.name = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter your email address.';
    const e164 = toE164(country, phone);
    if (e164 === null)
      errs.phone =
        country === 'US'
          ? 'Enter a 10-digit US mobile number.'
          : 'Enter a 10-digit Indian mobile number.';
    if (residence === '') errs.residence = 'Choose where you live.';
    else if (residence === 'OTHER') errs.residence = REGION_MESSAGE;
    if (inviteRequired && invite.trim() === '') errs.invite = 'Enter your invite code.';
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
      .then((r) => onStarted(r.signup_id, email.trim(), e164))
      .catch((err: PersonalSignupError) => {
        const f = startFailure(err);
        if (f.kind === 'not_open') {
          onNotOpen();
        } else if (f.kind === 'refused') {
          // Neutral, non-enumerating: an explicit refusal shows the review screen.
          onRefused(email.trim());
        } else if (f.kind === 'invite_required' || f.kind === 'invite_invalid') {
          setInviteRequired(true);
          setErrors({
            invite:
              f.kind === 'invite_required'
                ? 'Personal accounts are invite-only right now. Enter your invite code.'
                : 'This invite code isn’t valid for this email, or it has expired.',
          });
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

  const aria = (k: FieldKey, help = false) => ariaFor(FIELD_ID[k], errors[k], help);
  const checking = siteKey !== null && robot === null;

  return (
    <form className="su-form" onSubmit={submit} noValidate>
      <StepHead
        title="Tell us about you"
        sub="For your free personal account. 5 documents a month."
      />
      <div className="su-fields">
        <SuField id="ps-name" label="Full name" error={errors.name}>
          <SuInput
            id="ps-name"
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              edit('name');
            }}
            {...aria('name')}
          />
        </SuField>
        <SuField
          id="ps-email"
          label="Personal email"
          help="Gmail, Outlook.com, Yahoo and similar. You’ll sign in with Google for this address."
          error={errors.email}
        >
          <SuInput
            id="ps-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              edit('email');
            }}
            {...aria('email', true)}
          />
        </SuField>
        <SuField
          id="ps-phone"
          label="Mobile number"
          help="Used only to verify your account and keep it secure — never for marketing."
          error={errors.phone}
        >
          <div className="su-phone">
            <SuSelect
              aria-label="Phone country"
              value={country}
              onChange={(e) => setCountry(e.target.value as Country)}
              data-testid="personal-phone-country"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {FLAG[c.code]} {c.dial}
                </option>
              ))}
            </SuSelect>
            <SuInput
              id="ps-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder={country === 'US' ? '(415) 555-0100' : '98765 43210'}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                edit('phone');
              }}
              style={{ flex: 1, minWidth: 0 }}
              {...aria('phone', true)}
            />
          </div>
        </SuField>
        <SuField id="ps-residence" label="Country of residence" error={errors.residence}>
          <SuSelect
            id="ps-residence"
            value={residence}
            onChange={(e) => {
              setResidence(e.target.value as Residence);
              edit('residence');
            }}
            {...aria('residence')}
          >
            <option value="">Choose…</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
            <option value="OTHER">Another country</option>
          </SuSelect>
        </SuField>
        {residence === 'OTHER' && errors.residence !== undefined ? (
          <Alert testId="personal-region">
            Outside the US and India? You can <a href="/signup">create a Business account</a> for a
            US organization instead.
          </Alert>
        ) : null}
        <SuField
          id="ps-invite"
          label="Invite code"
          optional={!inviteRequired}
          help="Only if you were invited to the pilot"
          error={errors.invite}
        >
          <SuInput
            id="ps-invite"
            mono
            autoComplete="off"
            value={invite}
            onChange={(e) => {
              setInvite(e.target.value);
              edit('invite');
            }}
            {...aria('invite', true)}
          />
        </SuField>
        {/* Honeypot (§6.1): invisible to people, filled only by form robots. */}
        <div aria-hidden="true" className="su-hp">
          <label htmlFor="ps-website">Website</label>
          <SuInput
            id="ps-website"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
            data-testid="personal-hp"
          />
        </div>
        <Turnstile siteKey={siteKey} onToken={setRobot} />
      </div>
      {failure !== null ? <FailureBox f={failure} /> : null}
      {/* Notice at the point of collection (Aramo Privacy Notice). */}
      <p className="su-hint" data-testid="personal-privacy-notice">
        We use your details as described in our{' '}
        <a href={legalPath('privacy')} target="_blank" rel="noopener noreferrer">
          Privacy Notice
        </a>
        .
      </p>
      <StepFooter>
        {checking ? (
          <span className="su-hint" id="ps-checking">
            Complete the security check to continue
          </span>
        ) : null}
        <PrimaryBtn
          type="submit"
          disabled={busy || checking}
          data-testid="personal-submit"
          {...(checking ? { 'aria-describedby': 'ps-checking' } : {})}
        >
          {busy ? 'Sending code…' : 'Continue'}
        </PrimaryBtn>
      </StepFooter>
      <p className="su-hint">
        Signing up for a company? <a href="/signup">Create a Business account</a>. Already have an
        account? <a href="/login">Sign in</a>
      </p>
      {/* GeoLite2 licence attribution (network location is one signup risk signal). */}
      <p className="su-hint" style={{ fontSize: 11 }} data-testid="personal-maxmind">
        {MAXMIND_ATTRIBUTION.replace(`${MAXMIND_URL}.`, '')}
        <a href={MAXMIND_URL} target="_blank" rel="noopener noreferrer">
          {MAXMIND_URL}
        </a>
        . <a href={THIRD_PARTY_NOTICES_PATH}>Third-party notices</a>
      </p>
    </form>
  );
}

function FailureBox({ f }: { f: StartFailure }) {
  switch (f.kind) {
    case 'business_email':
      return (
        <Alert>
          <span data-testid="personal-error-business">
            <b>That looks like a work email.</b> Personal accounts use a personal email address,
            like Gmail. <a href="/signup">Create a Business account</a> instead, or use your
            personal email.
          </span>
        </Alert>
      );
    case 'disposable':
      return (
        <Alert>
          <span data-testid="personal-error-disposable">
            <b>Disposable email addresses aren’t allowed.</b> Use your personal email address.
          </span>
        </Alert>
      );
    case 'location':
      return (
        <Alert>
          <span data-testid="personal-error-location">{LOCATION_MESSAGE}</span>
        </Alert>
      );
    case 'rate_limited':
      return <Alert>Too many attempts. Wait a few minutes and try again.</Alert>;
    case 'field':
    case 'other':
      return <Alert>{f.message}</Alert>;
    default:
      return <Alert>Something went wrong. Try again.</Alert>;
  }
}

// ── One-time code steps ────────────────────────────────────────────────────

function CodeStep({
  id,
  title,
  sub,
  submitLabel,
  verify,
  resend,
  onNext,
  onRestart,
}: {
  id: string;
  title: string;
  sub: ReactNode;
  submitLabel: string;
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
  const [left, resetTimer] = useCountdown();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter all 6 digits.');
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
        setError(
          err.status === 429 ? 'You’ve asked for too many codes. Try again later.' : f.message,
        );
        setRestart(f.restart);
      });
  };

  if (restart) {
    return (
      <div className="su-form">
        <StateBlock
          heading="step"
          tone="amber"
          icon="lock"
          title="Too many tries"
          sub={error ?? 'Start again to get a new code.'}
        >
          <StepFooter>
            <PrimaryBtn onClick={onRestart} data-testid="code-restart">
              Start again
            </PrimaryBtn>
          </StepFooter>
        </StateBlock>
      </div>
    );
  }

  return (
    <form className="su-form" onSubmit={submit} noValidate>
      <StepHead title={title} sub={sub} />
      <CodeBoxes
        id={id}
        label="6-digit code"
        value={code}
        onChange={(v) => {
          setCode(v);
          setError(null);
        }}
        error={error ?? undefined}
      />
      <Resend left={left} onResend={again} />
      {notice !== null ? (
        <p className="su-hint" role="status">
          {notice}
        </p>
      ) : null}
      <StepFooter>
        <PrimaryBtn type="submit" disabled={busy || code.length !== 6} data-testid="code-submit">
          {busy ? 'Checking…' : submitLabel}
        </PrimaryBtn>
      </StepFooter>
    </form>
  );
}

function PhoneStep({
  id,
  masked,
  onNext,
  onUnavailable,
  onRestart,
}: {
  id: string;
  masked: string;
  onNext: (next: NextStep) => void;
  onUnavailable: () => void;
  onRestart: () => void;
}) {
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
      <div className="su-form" data-testid="personal-phone-error">
        <StateBlock
          heading="step"
          tone="amber"
          icon="warn"
          title="We couldn’t send a code to your phone"
        >
          <Alert>{error}</Alert>
          <StepFooter>
            <PrimaryBtn onClick={onRestart}>Start again</PrimaryBtn>
          </StepFooter>
        </StateBlock>
      </div>
    );
  }
  if (sent === null) {
    return (
      <p className="su-hint" role="status">
        Sending a code to your phone…
      </p>
    );
  }
  return (
    <div data-testid="personal-phone-code">
      <CodeStep
        id="personal-phone-code-input"
        title="Verify your phone"
        sub={
          <>
            We texted a 6-digit code to <strong>{masked}</strong>. Only some new accounts need this
            step.
          </>
        }
        submitLabel="Verify phone"
        verify={(code) =>
          personalPost<{ next?: NextStep }>('phone/verify', { signup_id: id, code }).then((r) =>
            r.next === 'review' ? 'review' : 'terms',
          )
        }
        resend={() =>
          personalPost<{ sent: boolean }>('phone/send', { signup_id: id }).then((r) => {
            if (!r.sent) onUnavailable();
            return r.sent;
          })
        }
        onNext={onNext}
        onRestart={onRestart}
      />
    </div>
  );
}

// ── Legal acceptance (§3 step 4) ───────────────────────────────────────────

function TermsStep({
  id,
  withPhone,
  notice,
  onDone,
  onRestart,
}: {
  id: string;
  withPhone: boolean;
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
    personalPost<CompleteResponse>('complete', {
      signup_id: id,
      accept: docs.map((d) => ({ key: d.key, version: d.version })),
    })
      .then((r) => {
        if (r.status === 'PROVISIONED')
          onDone(typeof r.sign_in?.google === 'string' ? r.sign_in.google : null, r.held);
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
      <Shell withPhone={withPhone} testId="personal-expired">
        <StateBlock
          heading="step"
          tone="amber"
          icon="warn"
          title="This signup has expired"
          sub="Start again and we’ll send you a new code."
        >
          <StepFooter>
            <PrimaryBtn onClick={onRestart}>Start again</PrimaryBtn>
          </StepFooter>
        </StateBlock>
      </Shell>
    );
  }
  if (docs === null) {
    return (
      <Shell withPhone={withPhone} testId="personal-terms-unavailable">
        <StateBlock
          heading="step"
          tone="grey"
          icon="clock"
          title={NOT_OPEN_MESSAGE}
          sub="Your email is confirmed, but we can’t create personal accounts yet. Please try again later."
        />
      </Shell>
    );
  }
  return (
    <Shell
      step="terms"
      withPhone={withPhone}
      testId={docs === undefined && error === null ? 'personal-terms-loading' : 'personal-terms'}
    >
      {docs === undefined && error === null ? (
        <p className="su-hint" role="status">
          Loading the terms…
        </p>
      ) : (
        <form className="su-form" onSubmit={submit} noValidate>
          <StepHead title="Review and accept" sub="Read these before you activate your account." />
          {notice !== undefined ? (
            <div className="su-banner" role="status" data-testid="personal-phone-unavailable">
              <span className="su-banner__icon">
                <SuIcon name="info" size={18} />
              </span>
              <span>{notice}</span>
            </div>
          ) : null}
          <div className="su-docs" data-testid="personal-terms-docs">
            {(docs ?? []).map((d) => (
              <div key={d.key} className="su-docs__row">
                <a href={d.url} target="_blank" rel="noopener noreferrer">
                  {documentLabel(d.key)}
                </a>
                <span className="su-docs__ver">v{d.version}</span>
              </div>
            ))}
          </div>
          <div className="su-plan" data-testid="personal-plan">
            <b>Free plan · 5 documents a month · up to 2 a day</b>
            The free plan may change. We’ll tell you before it does.
          </div>
          <SuCheck id="ps-accept" checked={agreed} onChange={setAgreed} testId="personal-accept">
            I agree to these documents.
          </SuCheck>
          {error !== null ? <Alert>{error}</Alert> : null}
          <StepFooter>
            <PrimaryBtn
              type="submit"
              disabled={busy || !agreed || docs === undefined}
              data-testid="personal-complete"
            >
              {busy ? 'Activating…' : 'Activate my account'}
            </PrimaryBtn>
          </StepFooter>
        </form>
      )}
    </Shell>
  );
}
