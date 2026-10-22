import { useEffect, useState, type FormEvent } from 'react';

import { Btn, Check, ErrorBox, Field, fieldErrorId, Loading, Sel, TextIn } from '../ui';

import { AddressAutocomplete, type AddressSuggestion } from './AddressAutocomplete';
import { toOrganizationPayload, US_STATES, validateOrgDetails, type FieldErrors, type OrgDetailsValues } from './organization-details';

// Aramo Sign launch (Journey B) — public self-service BUSINESS signup on
// esign.aramo.ai. Session-less: these pages talk only to /v1/signup/sign/*.
//   /signup         work email + organization + name → "check your email"
//   /signup/verify  the emailed link (#token=… in the URL fragment, never sent to
//                   a server log) → confirm → organization created; the owner
//                   signs in with Google or Microsoft (no password is issued —
//                   Sign-Signup-Federated-Owner R3).
// Nothing here grants access: the new owner signs in, then subscribes (the
// subscription — never the signup — gives sending).

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
  const res = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: { reason?: string; field?: string } } } & T;
  if (!res.ok) {
    const err: SignupError = { status: res.status, message: json.error?.message ?? 'Something went wrong. Try again.' };
    if (json.error?.code !== undefined) err.code = json.error.code;
    if (json.error?.details?.reason !== undefined) err.reason = json.error.details.reason;
    if (json.error?.details?.field !== undefined) err.field = json.error.details.field;
    throw err;
  }
  return json;
}

function Frame({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="sg sg-center" data-testid={testId}>
      <div className="sg-state" style={{ maxWidth: 480, textAlign: 'left' }}>
        <div className="sg-state__mark">S</div>
        <h1 className="sg-h1">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function SignupPage() {
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    post<{ accepted: true }>('start', {
      email: email.trim(),
      organization_name: org.trim(),
      ...(name.trim() !== '' ? { display_name: name.trim() } : {}),
      ...(termsDoc !== null ? { accept_terms: terms } : {}),
    })
      .then(() => setSentTo(email.trim()))
      .catch((err: SignupError) => setError(err.status === 404 ? 'Signing up online isn’t available yet.' : err.message))
      .finally(() => setBusy(false));
  };

  if (unavailable) {
    return (
      <Frame title="Signing up online isn’t available yet" testId="signup-unavailable">
        <div className="sg-lede">Contact Aramo to set up Aramo Sign for your organization.</div>
      </Frame>
    );
  }

  if (sentTo !== null) {
    return (
      <Frame title="Check your email" testId="signup-sent">
        <div className="sg-lede">
          If <strong>{sentTo}</strong> can be used for a new organization, we’ve sent a link to confirm it. The link works for 24 hours.
        </div>
        <p className="sg-help">Nothing is created until you open the link. No email? Check spam, or try again in a minute.</p>
      </Frame>
    );
  }

  return (
    <Frame title="Create your Aramo Sign organization" testId="signup-form">
      <div className="sg-lede" style={{ marginBottom: 16 }}>
        Send documents for signature with a secure link and a tamper-evident audit certificate.
      </div>
      <form className="sg-grid" style={{ gap: 12 }} onSubmit={submit}>
        <Field label="Work email" htmlFor="su-email">
          <TextIn id="su-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Organization name" htmlFor="su-org">
          <TextIn id="su-org" required minLength={2} maxLength={100} autoComplete="organization" value={org} onChange={(e) => setOrg(e.target.value)} />
        </Field>
        <Field label="Your name" htmlFor="su-name">
          <TextIn id="su-name" maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {termsDoc !== null ? (
          <label className="sg-settings-row">
            <Check checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="signup-terms" />
            <span>
              I agree to the{' '}
              <a href={termsDoc.url} target="_blank" rel="noopener noreferrer">
                Aramo Sign Terms of Service
              </a>{' '}
              (version {termsDoc.version})
            </span>
          </label>
        ) : null}
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <Btn variant="primary" type="submit" disabled={busy || (termsDoc !== null && !terms)} data-testid="signup-submit">
          {busy ? 'Sending…' : 'Continue'}
        </Btn>
        <p className="sg-help" data-testid="signup-eligibility">
          Sign in with a Google or Microsoft work account. If your organization uses another sign-in provider, contact sales.
        </p>
        {personalOpen ? (
          <p className="sg-help" data-testid="signup-personal-link">
            Signing up for yourself? <a href="/signup/personal">Create a free personal account</a>
          </p>
        ) : null}
        <p className="sg-help">
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </form>
    </Frame>
  );
}

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

// Amendment A1 §2.2 — the page states the US-only scope before any data entry.
const CONTACT_SALES_URL = 'https://aramo.ai/company/contact.html?route=Aramo%20Sign';

interface Preview {
  email: string;
  organization_name: string;
  display_name?: string | null;
  status: string;
}

type FieldKey = keyof FieldErrors;
const FORM_FIELDS: ReadonlySet<string> = new Set<FieldKey>([
  'organization_name',
  'legal_name',
  'address_line1',
  'address_line2',
  'city',
  'state_province',
  'postal_code',
  'primary_contact_email',
  'primary_contact_name',
  'signer_title',
  'primary_contact_phone',
  'tax_id',
  'registration_number',
  'authority_attested',
]);

const FIELD_INPUT_ID: Record<FieldKey, string> = {
  organization_name: 'sv-org',
  legal_name: 'sv-legal',
  address_line1: 'sv-line1',
  address_line2: 'sv-line2',
  city: 'sv-city',
  state_province: 'sv-state',
  postal_code: 'sv-zip',
  primary_contact_email: 'sv-email',
  primary_contact_name: 'sv-name',
  signer_title: 'sv-title',
  primary_contact_phone: 'sv-phone',
  tax_id: 'sv-ein',
  registration_number: 'sv-reg',
  authority_attested: 'sv-authority',
};

function serverField(field: string | undefined): FieldKey | null {
  if (field === undefined) return null;
  const f = field.replace(/^organization\./, '');
  return FORM_FIELDS.has(f) ? (f as FieldKey) : null;
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

export function SignupVerifyPage() {
  const [token] = useState(() => tokenFromHash());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [org, setOrg] = useState('');
  const [nameTaken, setNameTaken] = useState(false);
  const [values, setValues] = useState<OrgDetailsValues>(EMPTY);
  const [attested, setAttested] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CompleteResponse | null>(null);

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read.
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
    if (token === null) {
      setInvalid(true);
      return;
    }
    post<Preview>('preview', { token })
      .then((p) => {
        setPreview(p);
        setOrg(p.organization_name);
        // Defaults: billing contact = the confirmed email; signer = the step-1 name.
        setValues((v) => ({ ...v, primary_contact_email: p.email, primary_contact_name: p.display_name ?? '' }));
      })
      .catch(() => setInvalid(true));
  }, [token]);

  const set = (k: keyof OrgDetailsValues) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setFieldErrors((prev) => {
      if (prev[k] === undefined) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };

  const fillAddress = (a: AddressSuggestion) => {
    setValues((prev) => ({
      ...prev,
      address_line1: a.address_line1,
      address_line2: a.address_line2 ?? '',
      city: a.city,
      state_province: US_STATES.some(([c]) => c === a.state_province) ? a.state_province : prev.state_province,
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
    // Defer until the inline message is rendered.
    setTimeout(() => document.getElementById(FIELD_INPUT_ID[k])?.focus(), 0);
  };

  const onFailure = (err: SignupError) => {
    if (err.status === 404) return setInvalid(true);
    if (err.reason === 'organization_name_taken') {
      setNameTaken(true);
      setFieldErrors((p) => ({ ...p, organization_name: err.message }));
      return focusField('organization_name');
    }
    if (err.reason === 'organization_country_not_supported') return setError(err.message);
    const field = serverField(err.field) ?? (err.reason === 'authority_attestation_required' ? 'authority_attested' : null);
    if (field !== null) {
      setFieldErrors((p) => ({ ...p, [field]: err.message }));
      return focusField(field);
    }
    setError(err.message);
  };

  const finish = (body: Record<string, unknown>) => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    post<CompleteResponse>('complete', { token, ...body })
      .then((r) => {
        if (r.status === 'PROVISIONED') setDone(r);
        else setError('Your organization is still being created. Try again in a moment.');
      })
      .catch(onFailure)
      .finally(() => setBusy(false));
  };

  const submitDetails = (e: FormEvent) => {
    e.preventDefault();
    const errs: FieldErrors = validateOrgDetails(values, attested);
    if (nameTaken && (org.trim().length < 2 || org.trim().length > 100)) errs.organization_name = 'Enter an organization name (2–100 characters).';
    setFieldErrors(errs);
    const first = (Object.keys(FIELD_INPUT_ID) as FieldKey[]).find((k) => errs[k] !== undefined);
    if (first !== undefined) {
      setError(null);
      return focusField(first);
    }
    finish({ ...(nameTaken ? { organization_name: org.trim() } : {}), organization: toOrganizationPayload(values) });
  };

  if (invalid) {
    return (
      <Frame title="This link can’t be used" testId="signup-invalid">
        <div className="sg-lede">The link is invalid, has expired, or a newer one was sent. Start again to get a new link.</div>
        <a className="sg-btn sg-btn--primary" href="/signup">
          Start again
        </a>
      </Frame>
    );
  }
  if (done !== null) {
    return (
      <Frame title="Your organization is ready" testId="signup-done">
        <div className="sg-lede">
          <strong>{done.organization_name}</strong> is set up. Use the work account for <strong>{done.email}</strong>. The provider you sign in
          with first becomes your organization’s sign-in provider.
        </div>
        <p className="sg-help">After you sign in, choose a plan to start sending documents. You’ll be the organization’s owner.</p>
        {done.sign_in !== undefined ? (
          <div className="sg-grid" style={{ gap: 8 }}>
            <a className="sg-btn sg-btn--primary" href={done.sign_in.microsoft} data-testid="signup-signin-microsoft">
              Continue with Microsoft
            </a>
            <a className="sg-btn" href={done.sign_in.google} data-testid="signup-signin-google">
              Continue with Google
            </a>
          </div>
        ) : (
          <a className="sg-btn sg-btn--primary" href={done.sign_in_url} data-testid="signup-signin">
            Sign in
          </a>
        )}
      </Frame>
    );
  }
  if (preview === null || token === null) return <Loading label="Checking your link…" />;

  if (preview.status !== 'READY') {
    // Already created (e.g. the link was opened again): no details to collect —
    // completing again only returns the sign-in links.
    return (
      <Frame title="Your organization is already set up" testId="signup-confirm">
        <div className="sg-lede" style={{ marginBottom: 16 }}>
          Your email <strong>{preview.email}</strong> is confirmed.
        </div>
        <div className="sg-grid" style={{ gap: 12 }}>
          {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
          <Btn variant="primary" disabled={busy} onClick={() => finish({})} data-testid="signup-create">
            {busy ? 'Opening…' : 'Continue'}
          </Btn>
        </div>
      </Frame>
    );
  }

  const fe = fieldErrors;
  const aria = (k: FieldKey) =>
    fe[k] !== undefined ? { 'aria-invalid': true as const, 'aria-describedby': fieldErrorId(FIELD_INPUT_ID[k]) } : {};
  const who = values.legal_name.trim() !== '' ? values.legal_name.trim() : 'this organization';

  return (
    <Frame title="Organization details" testId="signup-confirm">
      <p className="sg-notice" data-testid="signup-us-notice">
        Aramo Sign is currently available to organizations registered in the United States. Outside the US?{' '}
        <a href={CONTACT_SALES_URL} target="_blank" rel="noopener noreferrer">
          Contact sales
        </a>
        .
      </p>
      <div className="sg-lede" style={{ margin: '12px 0 16px' }}>
        Your email <strong>{preview.email}</strong> is confirmed. Tell us about your organization — nothing is created until you finish.
      </div>
      <form className="sg-grid" style={{ gap: 12 }} onSubmit={submitDetails} noValidate data-testid="signup-details">
        {nameTaken ? (
          <Field label="Organization name" htmlFor="sv-org" error={fe.organization_name}>
            <TextIn id="sv-org" value={org} minLength={2} maxLength={100} onChange={(e) => setOrg(e.target.value)} {...aria('organization_name')} />
          </Field>
        ) : (
          <div>
            Organization name: <strong>{preview.organization_name}</strong>
          </div>
        )}
        <Field label="Legal name" htmlFor="sv-legal" help="As registered with your state" error={fe.legal_name}>
          <TextIn id="sv-legal" required maxLength={200} autoComplete="organization" value={values.legal_name} onChange={(e) => set('legal_name')(e.target.value)} {...aria('legal_name')} />
        </Field>
        <Field label="Street address" htmlFor="sv-line1" error={fe.address_line1}>
          <AddressAutocomplete
            id="sv-line1"
            token={token}
            value={values.address_line1}
            onChange={set('address_line1')}
            onSelect={fillAddress}
            invalid={fe.address_line1 !== undefined}
            {...(fe.address_line1 !== undefined ? { describedBy: fieldErrorId('sv-line1') } : {})}
          />
        </Field>
        <Field label="Address line 2 (optional)" htmlFor="sv-line2" error={fe.address_line2}>
          <TextIn id="sv-line2" maxLength={200} autoComplete="address-line2" value={values.address_line2} onChange={(e) => set('address_line2')(e.target.value)} {...aria('address_line2')} />
        </Field>
        <div className="sg-row2">
          <Field label="City" htmlFor="sv-city" error={fe.city}>
            <TextIn id="sv-city" required maxLength={100} autoComplete="address-level2" value={values.city} onChange={(e) => set('city')(e.target.value)} {...aria('city')} />
          </Field>
          <Field label="State" htmlFor="sv-state" error={fe.state_province}>
            <Sel id="sv-state" required autoComplete="address-level1" value={values.state_province} onChange={(e) => set('state_province')(e.target.value)} {...aria('state_province')}>
              <option value="">Choose…</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Sel>
          </Field>
          <Field label="ZIP code" htmlFor="sv-zip" error={fe.postal_code}>
            <TextIn id="sv-zip" required inputMode="numeric" maxLength={10} autoComplete="postal-code" value={values.postal_code} onChange={(e) => set('postal_code')(e.target.value)} {...aria('postal_code')} />
          </Field>
        </div>
        <Field label="Country" htmlFor="sv-country">
          <TextIn id="sv-country" value="United States" readOnly disabled />
        </Field>
        <Field label="Billing contact email" htmlFor="sv-email" error={fe.primary_contact_email}>
          <TextIn id="sv-email" type="email" required autoComplete="email" value={values.primary_contact_email} onChange={(e) => set('primary_contact_email')(e.target.value)} {...aria('primary_contact_email')} />
        </Field>
        <div className="sg-row2">
          <Field label="Your full name" htmlFor="sv-name" error={fe.primary_contact_name}>
            <TextIn id="sv-name" required maxLength={100} autoComplete="name" value={values.primary_contact_name} onChange={(e) => set('primary_contact_name')(e.target.value)} {...aria('primary_contact_name')} />
          </Field>
          <Field label="Your title" htmlFor="sv-title" error={fe.signer_title}>
            <TextIn id="sv-title" required maxLength={100} autoComplete="organization-title" value={values.signer_title} onChange={(e) => set('signer_title')(e.target.value)} {...aria('signer_title')} />
          </Field>
        </div>
        <Field label="Phone (optional)" htmlFor="sv-phone" error={fe.primary_contact_phone}>
          <TextIn id="sv-phone" type="tel" autoComplete="tel" value={values.primary_contact_phone} onChange={(e) => set('primary_contact_phone')(e.target.value)} {...aria('primary_contact_phone')} />
        </Field>
        <div className="sg-row2">
          <Field label="EIN (optional)" htmlFor="sv-ein" help="12-3456789" error={fe.tax_id}>
            <TextIn id="sv-ein" maxLength={10} value={values.tax_id} onChange={(e) => set('tax_id')(e.target.value)} {...aria('tax_id')} />
          </Field>
          <Field label="State registration number (optional)" htmlFor="sv-reg" error={fe.registration_number}>
            <TextIn id="sv-reg" maxLength={50} value={values.registration_number} onChange={(e) => set('registration_number')(e.target.value)} {...aria('registration_number')} />
          </Field>
        </div>
        <div className="sg-field">
          {/* A1 Refinement A — the signer's own attestation, never presented as verified authority. */}
          <label className="sg-settings-row" htmlFor="sv-authority">
            <Check
              id="sv-authority"
              checked={attested}
              onChange={(e) => {
                setAttested(e.target.checked);
                if (e.target.checked)
                  setFieldErrors((p) => {
                    const next = { ...p };
                    delete next.authority_attested;
                    return next;
                  });
              }}
              data-testid="signup-authority"
              {...aria('authority_attested')}
            />
            <span>I am authorized to act for {who} and to accept the Aramo terms on its behalf.</span>
          </label>
          {fe.authority_attested !== undefined ? (
            <div className="sg-field-error" id={fieldErrorId('sv-authority')}>
              {fe.authority_attested}
            </div>
          ) : null}
        </div>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <Btn variant="primary" type="submit" disabled={busy} data-testid="signup-create">
          {busy ? 'Creating…' : 'Create organization'}
        </Btn>
      </form>
    </Frame>
  );
}
