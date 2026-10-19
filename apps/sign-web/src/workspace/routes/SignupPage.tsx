import { useEffect, useState, type FormEvent } from 'react';

import { Btn, Check, ErrorBox, Field, Loading, TextIn } from '../ui';

// Aramo Sign launch (Journey B) — public self-service BUSINESS signup on
// esign.aramo.ai. Session-less: these pages talk only to /v1/signup/sign/*.
//   /signup         work email + organization + name → "check your email"
//   /signup/verify  the emailed link (#token=… in the URL fragment, never sent to
//                   a server log) → confirm → organization created; the sign-in
//                   details arrive by email from Aramo's identity service.
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
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: { reason?: string } } } & T;
  if (!res.ok) {
    const err: SignupError = { status: res.status, message: json.error?.message ?? 'Something went wrong. Try again.' };
    if (json.error?.code !== undefined) err.code = json.error.code;
    if (json.error?.details?.reason !== undefined) err.reason = json.error.details.reason;
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
        <p className="sg-help">
          Already have an account? <a href="/login">Sign in</a>
        </p>
      </form>
    </Frame>
  );
}

export function tokenFromHash(hash: string = window.location.hash): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return t !== null && t.length >= 20 ? t : null;
}

export function SignupVerifyPage() {
  const [token] = useState(() => tokenFromHash());
  const [preview, setPreview] = useState<{ email: string; organization_name: string; status: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [org, setOrg] = useState('');
  const [nameTaken, setNameTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; organization_name: string; sign_in_url: string } | null>(null);

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read.
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
    if (token === null) {
      setInvalid(true);
      return;
    }
    post<{ email: string; organization_name: string; status: string }>('preview', { token })
      .then((p) => {
        setPreview(p);
        setOrg(p.organization_name);
      })
      .catch(() => setInvalid(true));
  }, [token]);

  const complete = () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    post<{ status: string; email: string; organization_name: string; sign_in_url: string }>('complete', { token, ...(nameTaken ? { organization_name: org.trim() } : {}) })
      .then((r) => {
        if (r.status === 'PROVISIONED') setDone(r);
        else setError('Your organization is still being created. Try again in a moment.');
      })
      .catch((err: SignupError) => {
        if (err.status === 404) setInvalid(true);
        else if (err.reason === 'organization_name_taken') {
          setNameTaken(true);
          setError(err.message);
        } else setError(err.message);
      })
      .finally(() => setBusy(false));
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
          <strong>{done.organization_name}</strong> is set up. We’ve emailed the sign-in details for <strong>{done.email}</strong>: sign in with the
          temporary password from that email and choose your own.
        </div>
        <p className="sg-help">After you sign in, choose a plan to start sending documents. You’ll be the organization’s Aramo Sign owner.</p>
        <a className="sg-btn sg-btn--primary" href={done.sign_in_url} data-testid="signup-signin">
          Sign in
        </a>
      </Frame>
    );
  }
  if (preview === null) return <Loading label="Checking your link…" />;

  return (
    <Frame title="Create your organization" testId="signup-confirm">
      <div className="sg-lede" style={{ marginBottom: 16 }}>
        Your email <strong>{preview.email}</strong> is confirmed.
      </div>
      <div className="sg-grid" style={{ gap: 12 }}>
        {nameTaken ? (
          <Field label="Organization name" htmlFor="sv-org">
            <TextIn id="sv-org" value={org} minLength={2} maxLength={100} onChange={(e) => setOrg(e.target.value)} />
          </Field>
        ) : (
          <div>
            Organization: <strong>{preview.organization_name}</strong>
          </div>
        )}
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <Btn variant="primary" disabled={busy || (nameTaken && org.trim().length < 2)} onClick={complete} data-testid="signup-create">
          {busy ? 'Creating…' : 'Create organization'}
        </Btn>
      </div>
    </Frame>
  );
}
