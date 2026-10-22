import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@aramo/fe-foundation';

import { AddressAutocomplete, type AddressSuggestion } from './AddressAutocomplete';
import {
  FIELD_STEP,
  toOrganizationPayload,
  US_STATES,
  validateOrgDetails,
  type BusinessStep,
  type FieldErrors,
  type OrgDetailsValues,
} from './organization-details';
import {
  ActivationShell,
  Alert,
  ariaFor,
  CardTitle,
  CONTACT_SALES_URL,
  errorId,
  LinkBtn,
  LockedField,
  PrimaryBtn,
  ProviderLink,
  Resend,
  SignupFrame,
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

// Aramo Sign launch (Journey B) — public self-service BUSINESS signup on
// sign.aramo.ai. Session-less: these pages talk only to /v1/signup/sign/*.
//   /signup         account type + work email, organization, name (+ terms when a
//                   version is approved) → "check your email"
//   /signup/verify  the emailed link (#token=… in the URL fragment, never sent to
//                   a server log) → the activation steps (Organization → Address →
//                   Billing & identifiers → You → Review), all client-side, sent as
//                   ONE atomic `complete` → done: the owner signs in with Google or
//                   Microsoft (no password is issued — Sign-Signup-Federated-Owner
//                   v1.2 R3; organization details per Amendment A1 §2).
// Nothing here grants access: the new owner signs in, then subscribes (the
// subscription — never the signup — gives sending). The email-first order is
// LOCKED (A1 §2.1 step 1; v1.2 R3/R5): no provider sign-in before the
// organization exists (no JIT).

const API = '/v1/signup/sign';

// Commercial Plans Amendment A1 — the terms come from the backend's versioned
// registry (GET /v1/signup/sign/terms): null while no version is approved, so an
// unapproved text is never offered for acceptance.
type Terms = { version: string; url: string } | null;

interface SignupError {
  status: number;
  code?: string;
  message: string;
  reason?: string;
  field?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: { reason?: string; field?: string } };
  } & T;
  if (!res.ok) {
    const err: SignupError = {
      status: res.status,
      message: json.error?.message ?? 'Something went wrong. Try again.',
    };
    if (json.error?.code !== undefined) err.code = json.error.code;
    if (json.error?.details?.reason !== undefined) err.reason = json.error.details.reason;
    if (json.error?.details?.field !== undefined) err.field = json.error.details.field;
    throw err;
  }
  return json;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── /signup ────────────────────────────────────────────────────────────────

type AccountType = 'business' | 'personal';

type StartField = 'email' | 'org' | 'name' | 'terms';
const START_ID: Record<StartField, string> = {
  email: 'su-email',
  org: 'su-org',
  name: 'su-name',
  terms: 'su-terms',
};

/** The account-type radiogroup (§3.2): arrow keys move the selection. */
function AccountTypes({
  value,
  onChange,
  personalOpen,
}: {
  value: AccountType;
  onChange: (t: AccountType) => void;
  personalOpen: boolean;
}) {
  const types: { key: AccountType; title: string; tag: string; desc: string }[] = [
    {
      key: 'business',
      title: 'Business',
      tag: 'Paid plans',
      desc: 'For your organization. Choose a plan after you set up.',
    },
    ...(personalOpen
      ? [
          {
            key: 'personal' as const,
            title: 'Personal',
            tag: 'Free',
            desc: 'For yourself, 5 documents a month. US and India only.',
          },
        ]
      : []),
  ];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = types[(i + d + types.length) % types.length];
    if (next === undefined) return;
    onChange(next.key);
    refs.current[next.key]?.focus();
  };
  return (
    <div
      className="su-types"
      role="radiogroup"
      aria-label="Account type"
      data-testid="signup-types"
    >
      {types.map((t, i) => (
        <Button
          key={t.key}
          unstyled
          ref={(el) => {
            refs.current[t.key] = el;
          }}
          className="su-type"
          role="radio"
          aria-checked={value === t.key}
          tabIndex={value === t.key ? 0 : -1}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
          data-testid={`signup-type-${t.key}`}
        >
          <span className="su-type__radio" aria-hidden="true" />
          <span>
            <span className="su-type__title">
              {t.title}
              <span className={t.key === 'personal' ? 'su-tag su-tag--free' : 'su-tag'}>
                {t.tag}
              </span>
            </span>
            <span className="su-type__desc">{t.desc}</span>
          </span>
        </Button>
      ))}
    </div>
  );
}

export function SignupPage() {
  const [type, setType] = useState<AccountType>('business');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<StartField, string>>>({});
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [termsDoc, setTermsDoc] = useState<Terms>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Aramo Sign Personal (Free) — offered only while the Personal mode is not off
  // (its public terms route answers 404 when off).
  const [personalOpen, setPersonalOpen] = useState(false);

  useEffect(() => {
    fetch(`${API}/personal/terms`)
      .then((r) => setPersonalOpen(r.status !== 404))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch(`${API}/terms`)
      .then(async (r) => {
        if (r.status === 404) return setUnavailable(true);
        const j = (await r.json().catch(() => ({}))) as { terms?: Terms };
        setTermsDoc(j.terms ?? null);
      })
      .catch(() => undefined);
  }, []);

  const body = () => ({
    email: email.trim(),
    organization_name: org.trim(),
    ...(name.trim() !== '' ? { display_name: name.trim() } : {}),
    ...(termsDoc !== null ? { accept_terms: terms } : {}),
  });

  const clear = (k: StartField) => {
    setErrors((p) => {
      if (p[k] === undefined) return p;
      const n = { ...p };
      delete n[k];
      return n;
    });
    if (k === 'email') setRejected(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Partial<Record<StartField, string>> = {};
    if (!EMAIL_RE.test(email.trim())) errs.email = 'Enter your work email address.';
    if (org.trim().length < 2) errs.org = 'Enter your organization’s name (at least 2 characters).';
    if (termsDoc !== null && !terms) errs.terms = 'Agree to the Terms of Service to continue.';
    setErrors(errs);
    setRejected(false);
    setError(null);
    const first = (Object.keys(START_ID) as StartField[]).find((k) => errs[k] !== undefined);
    if (first !== undefined) {
      document.getElementById(START_ID[first])?.focus();
      return;
    }
    setBusy(true);
    post<{ accepted: true }>('start', body())
      .then(() => setSentTo(email.trim()))
      .catch((err: SignupError) => {
        if (err.status === 404) return setUnavailable(true);
        // The backend decides which addresses are personal or disposable; it
        // returns one reason for both (no split exists).
        if (err.reason === 'business_email_required') {
          setRejected(true);
          return document.getElementById(START_ID.email)?.focus();
        }
        if (err.reason === 'terms_not_accepted') return setErrors({ terms: err.message });
        if (err.status === 400) return setError(err.message);
        // Anything else: the neutral refusal — never a reason, never whether an account exists.
        setRefused(true);
      })
      .finally(() => setBusy(false));
  };

  if (unavailable) {
    return (
      <SignupFrame testId="signup-unavailable">
        <StateBlock
          tone="grey"
          icon="clock"
          title="Signing up online isn’t available yet"
          sub="Talk to our team and we’ll set up your organization."
        >
          <a
            className="su-btn su-btn--primary su-btn--block"
            href={CONTACT_SALES_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Contact sales
          </a>
        </StateBlock>
      </SignupFrame>
    );
  }

  if (refused) return <NeutralRefusal onBack={() => setRefused(false)} />;

  if (sentTo !== null) {
    return (
      <CheckEmail
        email={sentTo}
        onResend={() => post<{ accepted: true }>('start', body())}
        onRestart={() => {
          setSentTo(null);
          setTerms(false);
        }}
      />
    );
  }

  const aria = (k: StartField) => ariaFor(START_ID[k], errors[k], false);

  return (
    <SignupFrame testId="signup-form">
      <CardTitle
        title="Create your Aramo Sign account"
        sub={
          type === 'business'
            ? 'Choose an account type, then enter your work email. We’ll email you a link to finish setting up.'
            : 'Choose an account type, then continue. We’ll email you a code to confirm your address.'
        }
      />
      <AccountTypes value={type} onChange={setType} personalOpen={personalOpen} />
      {type === 'personal' ? (
        <div className="su-stack" data-testid="signup-personal">
          <a
            className="su-btn su-btn--primary su-btn--block"
            href="/signup/personal"
            data-testid="signup-personal-link"
          >
            Continue
          </a>
          <p className="su-hint">
            Personal accounts use a personal email address, like Gmail, and sign in with a personal
            Google account.
          </p>
          <p className="su-fine">
            You’ll review the Aramo Sign Personal Terms before you create your account.
          </p>
        </div>
      ) : (
        <form className="su-stack" onSubmit={submit} noValidate>
          <div className="su-stack su-stack--tight">
            <SuField id={START_ID.email} label="Work email" error={errors.email}>
              <SuInput
                id={START_ID.email}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clear('email');
                }}
                {...(rejected
                  ? { 'aria-invalid': true, 'aria-describedby': 'su-reject' }
                  : aria('email'))}
              />
            </SuField>
            {rejected ? (
              <div className="su-reject" role="alert" id="su-reject" data-testid="signup-reject">
                <span className="su-reject__title">That’s not a work email</span>
                Business accounts need a work email from your organization’s Google Workspace or
                Microsoft 365. Personal and disposable addresses can’t be used.
                {personalOpen ? (
                  <div>
                    <LinkBtn
                      onClick={() => setType('personal')}
                      data-testid="signup-switch-personal"
                    >
                      Create a free personal account instead
                    </LinkBtn>
                  </div>
                ) : null}
              </div>
            ) : null}
            <SuField id={START_ID.org} label="Organization name" error={errors.org}>
              <SuInput
                id={START_ID.org}
                maxLength={100}
                autoComplete="organization"
                value={org}
                onChange={(e) => {
                  setOrg(e.target.value);
                  clear('org');
                }}
                {...aria('org')}
              />
            </SuField>
            <SuField id={START_ID.name} label="Your name">
              <SuInput
                id={START_ID.name}
                maxLength={100}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </SuField>
            {termsDoc !== null ? (
              <SuCheck
                id={START_ID.terms}
                checked={terms}
                onChange={(v) => {
                  setTerms(v);
                  clear('terms');
                }}
                error={errors.terms}
                testId="signup-terms"
              >
                I agree to the{' '}
                <a
                  className="su-link"
                  href={termsDoc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Aramo Sign Terms of Service
                </a>{' '}
                (version {termsDoc.version})
              </SuCheck>
            ) : null}
          </div>
          {error !== null ? <Alert>{error}</Alert> : null}
          <PrimaryBtn
            type="submit"
            block
            disabled={busy || (termsDoc !== null && !terms)}
            data-testid="signup-submit"
          >
            {busy ? 'Sending…' : 'Continue'}
          </PrimaryBtn>
          <p className="su-hint" data-testid="signup-eligibility">
            After you set up, you sign in with your Google or Microsoft work account. Another
            sign-in provider?{' '}
            <a
              className="su-link"
              href={CONTACT_SALES_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Contact sales
            </a>
            .
          </p>
        </form>
      )}
      <div className="su-card-foot">
        Already have an account?{' '}
        <a className="su-link" href="/login">
          Sign in
        </a>
      </div>
    </SignupFrame>
  );
}

/** §3.5 — Check your email, with a resend that waits 60 seconds. */
function CheckEmail({
  email,
  onResend,
  onRestart,
}: {
  email: string;
  onResend: () => Promise<unknown>;
  onRestart: () => void;
}) {
  const [left, reset] = useCountdown();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resend = () => {
    setBusy(true);
    setNotice(null);
    // The backend answers the same way whether or not it sends again (it ignores a
    // resend within 60 seconds and caps them per day): say only that we asked.
    onResend()
      .then(() => setNotice('We asked for another email. It can take a few minutes.'))
      .catch(() => setNotice('We couldn’t ask for another email. Try again in a minute.'))
      .finally(() => {
        setBusy(false);
        reset();
      });
  };
  return (
    <SignupFrame testId="signup-sent">
      <StateBlock
        tone="blue"
        icon="mail"
        title="Check your email"
        sub={
          <>
            We sent an email to <strong>{email}</strong>. Open the link in it to finish setting up
            your organization.
          </>
        }
      >
        <div className="su-info">
          The link expires in 24 hours. Check your spam folder if it doesn’t arrive in a few
          minutes.
        </div>
        <Resend left={left} onResend={resend} busy={busy} />
        {notice !== null ? (
          <p className="su-hint" role="status">
            {notice}
          </p>
        ) : null}
        <div>
          <LinkBtn onClick={onRestart} data-testid="signup-restart">
            Use a different email
          </LinkBtn>
        </div>
      </StateBlock>
    </SignupFrame>
  );
}

/** §3.6 — neutral refusal: never a reason, never whether an account exists. */
function NeutralRefusal({ onBack }: { onBack?: () => void }) {
  return (
    <SignupFrame testId="signup-refused">
      <StateBlock
        tone="grey"
        icon="person"
        title="We couldn’t create your account right now"
        sub="Please try again later. If this keeps happening, our support team can help."
      >
        <a
          className="su-btn su-btn--primary su-btn--block"
          href={SUPPORT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Contact support
        </a>
        {onBack !== undefined ? (
          <div>
            <LinkBtn onClick={onBack}>Back to sign up</LinkBtn>
          </div>
        ) : (
          <a className="su-link" href="/signup">
            Back to sign up
          </a>
        )}
      </StateBlock>
    </SignupFrame>
  );
}

// ── /signup/verify — the activation steps ─────────────────────────────────

// POST /v1/signup/sign/complete (openapi/platform.yaml) — `sign_in` carries the
// sign host's login with the AUTH-SIGNIN-1 `idp` hint for each provider.
interface CompleteResponse {
  status: string;
  email: string;
  organization_name: string;
  sign_in_url: string;
  sign_in?: { microsoft: string; google: string };
}

export function tokenFromHash(hash: string = window.location.hash): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return t !== null && t.length >= 20 ? t : null;
}

interface Preview {
  email: string;
  organization_name: string;
  display_name?: string | null;
  status: string;
}

type FieldKey = keyof FieldErrors;
type WizardStep = BusinessStep | 'review';

const FIELD_INPUT_ID: Record<FieldKey, string> = {
  organization_name: 'sv-org',
  legal_name: 'sv-legal',
  address_line1: 'sv-line1',
  address_line2: 'sv-line2',
  city: 'sv-city',
  state_province: 'sv-state',
  postal_code: 'sv-zip',
  primary_contact_email: 'sv-email',
  primary_contact_phone: 'sv-phone',
  tax_id: 'sv-ein',
  registration_number: 'sv-reg',
  primary_contact_name: 'sv-name',
  signer_title: 'sv-title',
  authority_attested: 'sv-authority',
};

const BUSINESS_GROUPS: readonly StepGroupDef[] = [
  {
    label: 'Set up your organization',
    items: [
      { key: 'organization', label: 'Organization' },
      { key: 'address', label: 'Address' },
      { key: 'billing', label: 'Billing & identifiers' },
      { key: 'you', label: 'You' },
    ],
  },
  { label: 'Review and activate', items: [{ key: 'review', label: 'Review' }] },
];

const ORDER: readonly WizardStep[] = ['organization', 'address', 'billing', 'you', 'review'];

function serverField(field: string | undefined): FieldKey | null {
  if (field === undefined) return null;
  const f = field.replace(/^organization\./, '');
  return f in FIELD_INPUT_ID ? (f as FieldKey) : null;
}

const EMPTY: OrgDetailsValues = {
  legal_name: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state_province: '',
  postal_code: '',
  primary_contact_email: '',
  primary_contact_name: '',
  signer_title: '',
  primary_contact_phone: '',
  tax_id: '',
  registration_number: '',
};

type Terminal = 'invalid' | 'already' | 'account_exists';

export function SignupVerifyPage() {
  const [token] = useState(() => tokenFromHash());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [step, setStep] = useState<WizardStep>('organization');
  const [org, setOrg] = useState('');
  const [nameTaken, setNameTaken] = useState(false);
  const [values, setValues] = useState<OrgDetailsValues>(EMPTY);
  const [attested, setAttested] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CompleteResponse | null>(null);

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read. It is
    // deliberately never persisted, so a reload cannot resume these steps.
    if (window.location.hash !== '')
      window.history.replaceState(null, '', window.location.pathname);
    if (token === null) {
      setTerminal('invalid');
      return;
    }
    post<Preview>('preview', { token })
      .then((p) => {
        setPreview(p);
        if (p.status !== 'READY') return setTerminal('already');
        setOrg(p.organization_name);
        // Defaults: billing contact = the confirmed email; signer = the step-1 name.
        setValues((v) => ({
          ...v,
          primary_contact_email: p.email,
          primary_contact_name: p.display_name ?? '',
        }));
      })
      .catch(() => setTerminal('invalid'));
  }, [token]);

  const dropError = (k: FieldKey) =>
    setFieldErrors((prev) => {
      if (prev[k] === undefined) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });

  const set = (k: keyof OrgDetailsValues) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    dropError(k);
  };

  const fillAddress = (a: AddressSuggestion) => {
    setValues((prev) => ({
      ...prev,
      address_line1: a.address_line1,
      address_line2: a.address_line2 ?? '',
      city: a.city,
      state_province: US_STATES.some(([c]) => c === a.state_province)
        ? a.state_province
        : prev.state_province,
      postal_code: a.postal_code,
    }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.address_line1;
      delete next.address_line2;
      delete next.city;
      delete next.state_province;
      delete next.postal_code;
      return next;
    });
  };

  const focusField = (k: FieldKey) => {
    // Defer until the step and its inline message are rendered.
    setTimeout(() => document.getElementById(FIELD_INPUT_ID[k])?.focus(), 0);
  };

  /** All client-side errors, plus the organization name rule. */
  const allErrors = (): FieldErrors => {
    const errs = validateOrgDetails(values, attested);
    const n = org.trim();
    if (n.length < 2 || n.length > 100)
      errs.organization_name = 'Enter an organization name (2–100 characters).';
    return errs;
  };

  const goTo = (s: WizardStep) => {
    setError(null);
    setStep(s);
  };

  const next = () => {
    if (step === 'review') return;
    const all = allErrors();
    const mine: FieldErrors = {};
    for (const k of Object.keys(all) as FieldKey[]) if (FIELD_STEP[k] === step) mine[k] = all[k];
    setFieldErrors(mine);
    const first = (Object.keys(FIELD_INPUT_ID) as FieldKey[]).find((k) => mine[k] !== undefined);
    if (first !== undefined) return focusField(first);
    const i = ORDER.indexOf(step);
    goTo(ORDER[i + 1] ?? 'review');
  };

  const back = () => {
    const i = ORDER.indexOf(step);
    if (i > 0) goTo(ORDER[i - 1] ?? 'organization');
  };

  const showFieldError = (k: FieldKey, message: string) => {
    setFieldErrors({ [k]: message });
    setStep(FIELD_STEP[k]);
    focusField(k);
  };

  const onFailure = (err: SignupError) => {
    if (err.status === 404) return setTerminal('invalid');
    if (err.reason === 'organization_name_taken') {
      setNameTaken(true);
      return showFieldError('organization_name', err.message);
    }
    // Shown only after the emailed link proved the address (never at start).
    if (err.reason === 'organization_domain_taken') return setTerminal('already');
    if (err.code === 'EMAIL_UNAVAILABLE') return setTerminal('account_exists');
    if (err.reason === 'organization_country_not_supported') {
      setStep('organization');
      return setError(err.message);
    }
    const field =
      serverField(err.field) ??
      (err.reason === 'authority_attestation_required' ? 'authority_attested' : null);
    if (field !== null) return showFieldError(field, err.message);
    setError(
      err.status >= 500
        ? 'We couldn’t create your organization right now. Please try again later. If this keeps happening, our support team can help.'
        : err.message,
    );
  };

  const activate = () => {
    if (token === null || preview === null) return;
    // A last check of every step before the one atomic call.
    const all = allErrors();
    const first = (Object.keys(FIELD_INPUT_ID) as FieldKey[]).find((k) => all[k] !== undefined);
    if (first !== undefined) {
      const msg = all[first];
      if (msg !== undefined) return showFieldError(first, msg);
    }
    const rename = nameTaken || org.trim() !== preview.organization_name;
    setBusy(true);
    setError(null);
    post<CompleteResponse>('complete', {
      token,
      ...(rename ? { organization_name: org.trim() } : {}),
      organization: toOrganizationPayload(values),
    })
      .then((r) => {
        if (r.status === 'PROVISIONED') setDone(r);
        else setError('Your organization is still being created. Try again in a moment.');
      })
      .catch(onFailure)
      .finally(() => setBusy(false));
  };

  if (terminal === 'invalid') {
    return (
      <SignupFrame testId="signup-invalid">
        <StateBlock
          tone="amber"
          icon="warn"
          title="This link can’t be used"
          sub="It may have expired, or a newer link was sent. Start again and we’ll send a new link."
        >
          <a className="su-btn su-btn--primary su-btn--block" href="/signup">
            Start again
          </a>
        </StateBlock>
      </SignupFrame>
    );
  }
  if (terminal === 'already' || terminal === 'account_exists') {
    return (
      <SignupFrame testId="signup-already">
        <StateBlock
          tone="blue"
          icon="building"
          title={
            terminal === 'already'
              ? 'Your organization is already set up'
              : 'You already have an Aramo account'
          }
          sub={
            <>
              {terminal === 'already'
                ? 'Sign in to continue. If you need access, ask your organization’s owner to invite you.'
                : 'This email address already belongs to an Aramo account. Sign in instead.'}
            </>
          }
        >
          <a
            className="su-btn su-btn--primary su-btn--block"
            href="/login"
            data-testid="signup-go-signin"
          >
            Go to sign in
          </a>
        </StateBlock>
      </SignupFrame>
    );
  }
  if (preview === null || token === null) {
    return (
      <SignupFrame testId="signup-checking">
        <p className="su-hint" role="status">
          Checking your link…
        </p>
      </SignupFrame>
    );
  }

  // Header right: the address the link confirmed (no session exists yet, so never "Signed in as" — A2 §3.3).
  const who = (
    <>
      Confirmed email <b>{preview.email}</b>
    </>
  );

  if (done !== null) {
    return (
      <ActivationShell
        groups={BUSINESS_GROUPS}
        current="review"
        allDone
        who={who}
        testId="signup-done"
      >
        <span className="su-tile su-tile--green" aria-hidden="true">
          <SuIcon name="check" />
        </span>
        <StepHead
          title={`${done.organization_name} is active`}
          sub={
            <>
              Use the work account for <strong>{done.email}</strong>. The provider you sign in with
              first becomes your organization’s sign-in provider.
            </>
          }
        />
        <p className="su-hint" style={{ fontSize: 14 }}>
          Sign in to choose a plan and start sending documents. You’re the organization’s owner.
        </p>
        {done.sign_in !== undefined ? (
          <div className="su-providers" style={{ maxWidth: 360 }}>
            <ProviderLink
              provider="microsoft"
              href={done.sign_in.microsoft}
              testId="signup-signin-microsoft"
            />
            <ProviderLink
              provider="google"
              href={done.sign_in.google}
              testId="signup-signin-google"
            />
          </div>
        ) : (
          <div>
            <a
              className="su-btn su-btn--primary"
              href={done.sign_in_url}
              data-testid="signup-signin"
            >
              Sign in
            </a>
          </div>
        )}
      </ActivationShell>
    );
  }

  const fe = fieldErrors;
  const aria = (k: FieldKey, help = false) => ariaFor(FIELD_INPUT_ID[k], fe[k], help);
  const orgLabel = org.trim() !== '' ? org.trim() : 'this organization';

  const step1 = (
    <>
      <StepHead
        title="Let’s start with your organization"
        sub="These details appear on your documents, invoices and signing certificates."
      />
      <div className="su-fields">
        <LockedField
          id="signup-us-notice"
          label="Location"
          value="🇺🇸 United States"
          help={
            <>
              Aramo Sign Business is available to US organizations only. Outside the US?{' '}
              <a href={CONTACT_SALES_URL} target="_blank" rel="noopener noreferrer">
                Contact sales
              </a>
              .
            </>
          }
        />
        <SuField
          id="sv-legal"
          label="Legal name"
          help="As registered with the state"
          error={fe.legal_name}
        >
          <SuInput
            id="sv-legal"
            maxLength={200}
            autoComplete="organization"
            value={values.legal_name}
            onChange={(e) => set('legal_name')(e.target.value)}
            {...aria('legal_name', true)}
          />
        </SuField>
        <SuField
          id="sv-org"
          label="Organization name"
          help="Shown to people you send documents to"
          error={fe.organization_name}
        >
          <SuInput
            id="sv-org"
            maxLength={100}
            value={org}
            onChange={(e) => {
              setOrg(e.target.value);
              dropError('organization_name');
            }}
            {...aria('organization_name', true)}
          />
        </SuField>
      </div>
    </>
  );

  const step2 = (
    <>
      <StepHead
        title="Where is your organization registered?"
        sub="Start typing and pick your address to fill the fields."
      />
      <div className="su-fields">
        <SuField id="sv-line1" label="Street address" error={fe.address_line1}>
          <AddressAutocomplete
            id="sv-line1"
            className="su-input"
            token={token}
            value={values.address_line1}
            onChange={set('address_line1')}
            onSelect={fillAddress}
            invalid={fe.address_line1 !== undefined}
            {...(fe.address_line1 !== undefined ? { describedBy: errorId('sv-line1') } : {})}
          />
        </SuField>
        <SuField id="sv-line2" label="Address line 2" optional error={fe.address_line2}>
          <SuInput
            id="sv-line2"
            maxLength={200}
            autoComplete="address-line2"
            value={values.address_line2}
            onChange={(e) => set('address_line2')(e.target.value)}
            {...aria('address_line2')}
          />
        </SuField>
        <div className="su-grid3">
          <SuField id="sv-city" label="City" error={fe.city}>
            <SuInput
              id="sv-city"
              maxLength={100}
              autoComplete="address-level2"
              value={values.city}
              onChange={(e) => set('city')(e.target.value)}
              {...aria('city')}
            />
          </SuField>
          <SuField id="sv-state" label="State" error={fe.state_province}>
            <SuSelect
              id="sv-state"
              autoComplete="address-level1"
              value={values.state_province}
              onChange={(e) => set('state_province')(e.target.value)}
              {...aria('state_province')}
            >
              <option value="">Choose…</option>
              {US_STATES.map(([code]) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </SuSelect>
          </SuField>
          <SuField id="sv-zip" label="ZIP code" error={fe.postal_code}>
            <SuInput
              id="sv-zip"
              mono
              inputMode="numeric"
              maxLength={10}
              autoComplete="postal-code"
              value={values.postal_code}
              onChange={(e) => set('postal_code')(e.target.value)}
              {...aria('postal_code')}
            />
          </SuField>
        </div>
      </div>
    </>
  );

  const step3 = (
    <>
      <StepHead
        title="Billing and identifiers"
        sub="Invoices and receipts go to the billing contact. Identifiers are optional."
      />
      <div className="su-fields">
        <SuField id="sv-email" label="Billing contact email" error={fe.primary_contact_email}>
          <SuInput
            id="sv-email"
            type="email"
            autoComplete="email"
            value={values.primary_contact_email}
            onChange={(e) => set('primary_contact_email')(e.target.value)}
            {...aria('primary_contact_email')}
          />
        </SuField>
        <SuField id="sv-phone" label="Phone" optional error={fe.primary_contact_phone}>
          <SuInput
            id="sv-phone"
            type="tel"
            autoComplete="tel"
            placeholder="(415) 555-0100"
            value={values.primary_contact_phone}
            onChange={(e) => set('primary_contact_phone')(e.target.value)}
            {...aria('primary_contact_phone')}
          />
        </SuField>
        <SuField id="sv-ein" label="EIN" optional help="12-3456789" error={fe.tax_id}>
          <SuInput
            id="sv-ein"
            mono
            maxLength={10}
            value={values.tax_id}
            onChange={(e) => set('tax_id')(e.target.value)}
            {...aria('tax_id', true)}
          />
        </SuField>
        <SuField
          id="sv-reg"
          label="State registration number"
          optional
          error={fe.registration_number}
        >
          <SuInput
            id="sv-reg"
            maxLength={50}
            value={values.registration_number}
            onChange={(e) => set('registration_number')(e.target.value)}
            {...aria('registration_number')}
          />
        </SuField>
      </div>
    </>
  );

  const step4 = (
    <>
      <StepHead
        title="Tell us about you"
        sub="You’ll be the organization’s owner and can invite others after you activate."
      />
      <div className="su-fields">
        <LockedField
          id="sv-confirmed"
          label="Your email"
          value={preview.email}
          help="Confirmed by the link we sent. After you activate, you sign in with the Google or Microsoft account for this address."
        />
        <SuField id="sv-name" label="Your name" error={fe.primary_contact_name}>
          <SuInput
            id="sv-name"
            maxLength={100}
            autoComplete="name"
            value={values.primary_contact_name}
            onChange={(e) => set('primary_contact_name')(e.target.value)}
            {...aria('primary_contact_name')}
          />
        </SuField>
        <SuField id="sv-title" label="Your title" error={fe.signer_title}>
          <SuInput
            id="sv-title"
            maxLength={100}
            autoComplete="organization-title"
            value={values.signer_title}
            onChange={(e) => set('signer_title')(e.target.value)}
            {...aria('signer_title')}
          />
        </SuField>
        {/* A1 Refinement A — the signer's own attestation, never presented as verified authority. */}
        <SuCheck
          id="sv-authority"
          checked={attested}
          onChange={(v) => {
            setAttested(v);
            if (v) dropError('authority_attested');
          }}
          error={fe.authority_attested}
          testId="signup-authority"
        >
          I am authorized to act for <strong>{orgLabel}</strong> and to accept the Aramo terms on
          its behalf.
        </SuCheck>
      </div>
    </>
  );

  const v = values;
  const lines = (...xs: (string | null | undefined)[]) =>
    xs.filter((x): x is string => x !== null && x !== undefined && x.trim() !== '').join('\n');
  const reviewRows: { key: BusinessStep; label: string; value: string }[] = [
    {
      key: 'organization',
      label: 'Organization',
      value: lines(v.legal_name, org.trim(), 'United States'),
    },
    {
      key: 'address',
      label: 'Address',
      value: lines(
        v.address_line1,
        v.address_line2,
        `${v.city}, ${v.state_province} ${v.postal_code}`,
      ),
    },
    {
      key: 'billing',
      label: 'Billing & identifiers',
      value: lines(
        v.primary_contact_email,
        v.primary_contact_phone !== '' ? `Phone ${v.primary_contact_phone}` : null,
        v.tax_id !== '' ? `EIN ${v.tax_id}` : null,
        v.registration_number !== '' ? `State registration ${v.registration_number}` : null,
      ),
    },
    {
      key: 'you',
      label: 'You',
      value: lines(
        v.signer_title !== ''
          ? `${v.primary_contact_name}, ${v.signer_title}`
          : v.primary_contact_name,
        preview.email,
      ),
    },
  ];

  const step5 = (
    <>
      <StepHead
        title="Review and activate"
        sub="Check everything once. You can change these later in Organization settings."
      />
      <div className="su-review" data-testid="signup-review">
        {reviewRows.map((r) => (
          <div key={r.key} className="su-review__row">
            <span className="su-review__text">
              <span className="su-review__label">{r.label}</span>
              <span className="su-review__value">{r.value}</span>
            </span>
            <LinkBtn
              onClick={() => goTo(r.key)}
              aria-label={`Edit ${r.label}`}
              data-testid={`review-edit-${r.key}`}
            >
              Edit
            </LinkBtn>
          </div>
        ))}
      </div>
    </>
  );

  const body = { organization: step1, address: step2, billing: step3, you: step4, review: step5 }[
    step
  ];

  return (
    <ActivationShell
      groups={BUSINESS_GROUPS}
      current={step}
      onGo={(k) => goTo(k as WizardStep)}
      who={who}
      testId="signup-confirm"
    >
      <form
        className="su-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'review') activate();
          else next();
        }}
        noValidate
        data-testid={`signup-step-${step}`}
      >
        {body}
        {error !== null ? <Alert>{error}</Alert> : null}
        <StepFooter {...(step !== 'organization' ? { onBack: back } : {})}>
          {step === 'review' ? (
            <PrimaryBtn type="submit" disabled={busy} data-testid="signup-create">
              {busy ? 'Activating…' : 'Activate organization'}
            </PrimaryBtn>
          ) : (
            <PrimaryBtn type="submit" data-testid="signup-next">
              Continue
            </PrimaryBtn>
          )}
        </StepFooter>
      </form>
    </ActivationShell>
  );
}
