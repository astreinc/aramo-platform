import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@aramo/fe-foundation';

import type { PrivacyRequestType, PrivacyRequestView } from '../api';
import { ARAMO_SIGN_IDENTITY, HELP_PATH } from '../legal/identity';
import { PrivacyRequestResult } from '../privacy/PrivacyRequestResult';

import { Alert, CardTitle, PrimaryBtn, SecondaryBtn, SuField, SuIcon, SuInput, type IconName, type Tone } from './signup-ui';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — https://sign.aramo.ai/delete-account, the
// stable public deletion page (the Play Data safety "delete account" URL). It works
// without the app and without signing in, names the app and its developer, and
// proves email ownership: the emailed link carries a one-time token in the URL
// FRAGMENT (#token=…, never in a request line or a server log), which this page
// sends back in a POST body. The start answers the same whether or not an account
// exists. Status is shown by request ID (+ the email) at any time.
// Aramo-Sign-Mobile-Amendment-M-A8 §2.2 — the page is titled "Privacy and account
// requests" (the URL stays): Personal account owners may delete their account; an
// account from an organization is managed by that organization, and its deletion
// request (eligible personal information) is referred and reviewed, never automatic.

type View =
  | { kind: 'form' }
  | { kind: 'sent'; email: string }
  | { kind: 'verifying' }
  | { kind: 'invalid' }
  | { kind: 'request'; request: PrivacyRequestView };

export const PRIVACY_TYPES: readonly { key: PrivacyRequestType; label: string; sub: string }[] = [
  {
    key: 'DELETION',
    label: 'Delete my account or personal information',
    sub: 'Personal account: close it and delete your data. Account from an organization: delete eligible personal information',
  },
  { key: 'ACCESS', label: 'See my data', sub: 'Find out what personal data Aramo Sign holds about you' },
  { key: 'EXPORT', label: 'Get a copy of my data', sub: 'Receive a copy of your data' },
  { key: 'CORRECTION', label: 'Correct my data', sub: 'Fix personal data that is wrong' },
];

export function privacyTokenFromHash(hash: string = window.location.hash): string | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return t !== null && t.length >= 32 ? t : null;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json: T | null = null;
  try {
    json = (await res.json()) as T;
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function Frame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="su su--grey" data-testid={testId}>
      <header className="su-head">
        <span className="su-head__name">Aramo Sign</span>
      </header>
      <main className="su-center">
        <section className="su-panel" aria-live="polite">
          {children}
        </section>
      </main>
    </div>
  );
}

function Tile({ tone, icon }: { tone: Tone; icon: IconName }) {
  return (
    <span className={`su-tile su-tile--${tone}`} aria-hidden="true">
      <SuIcon name={icon} />
    </span>
  );
}

/** Names the app and its developer (M-A7 §3.3, §5.1 identity block). */
function AppIdentity() {
  return (
    <p className="su-hint" data-testid="delete-account-identity">
      Aramo Sign is developed and operated by {ARAMO_SIGN_IDENTITY.legalEntity}, {ARAMO_SIGN_IDENTITY.postalAddress}. Privacy questions:{' '}
      <a href={`mailto:${ARAMO_SIGN_IDENTITY.privacyEmail}`}>{ARAMO_SIGN_IDENTITY.privacyEmail}</a> · <a href={HELP_PATH}>Help</a>
    </p>
  );
}

function WhatHappens() {
  return (
    <div className="su-hint" data-testid="delete-account-explainer">
      <p style={{ margin: '0 0 6px' }}>
        <strong>Personal account:</strong> we sign you out everywhere, delete your saved signatures and initials, contacts, notifications and
        device registrations and your unsent drafts with their files, and close the account. Signed agreements and their evidence, legal
        acceptances, security logs and abuse reports are kept as our retention rules require; we list them with your request.
      </p>
      <p style={{ margin: 0 }}>
        <strong>Account from an organization:</strong> your organization manages your account and its product access; contact your organization
        administrator to change access. A deletion request is referred to your organization and reviewed by the Aramo privacy team: eligible
        personal information is deleted after review, your organization decides about documents it sent or that you received in your role, and
        we remain responsible for your request.
      </p>
    </div>
  );
}

function StatusLookup({ onFound }: { onFound: (r: PrivacyRequestView) => void }) {
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    post<PrivacyRequestView>('/v1/sign/privacy-requests/status', { reference: reference.trim(), email: email.trim() })
      .then((r) => (r.status === 200 && r.body !== null ? onFound(r.body) : setError('No request matches that request ID and email.')))
      .catch(() => setError('We couldn’t check the status. Check your connection and try again.'))
      .finally(() => setBusy(false));
  };
  return (
    <form className="su-stack" onSubmit={submit} noValidate data-testid="privacy-status-form">
      <CardTitle title="Check a request" sub="Enter the request ID we gave you and the email you used." />
      <SuField id="privacy-reference-input" label="Request ID">
        <SuInput id="privacy-reference-input" mono placeholder="PR-XXXX-XXXX-XXXX" value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" />
      </SuField>
      <SuField id="privacy-status-email" label="Email">
        <SuInput id="privacy-status-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </SuField>
      {error !== null ? <Alert>{error}</Alert> : null}
      <SecondaryBtn type="submit" disabled={busy || reference.trim() === '' || email.trim() === ''} data-testid="privacy-status-submit">
        {busy ? 'Checking…' : 'Check status'}
      </SecondaryBtn>
    </form>
  );
}

export function DeleteAccountPage() {
  const [token] = useState(() => privacyTokenFromHash());
  const [view, setView] = useState<View>(() => (token !== null ? { kind: 'verifying' } : { kind: 'form' }));
  const [type, setType] = useState<PrivacyRequestType>('DELETION');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    // Drop the token from the address bar (history, screenshots) once read.
    if (window.location.hash !== '') window.history.replaceState(null, '', window.location.pathname);
    if (token === null) return;
    post<PrivacyRequestView>('/v1/sign/privacy-requests/verify', { token })
      .then((r) => setView(r.status === 200 && r.body !== null ? { kind: 'request', request: r.body } : { kind: 'invalid' }))
      .catch(() => setView({ kind: 'invalid' }));
  }, [token]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    post('/v1/sign/privacy-requests/start', { email: value, request_type: type })
      .then((r) => {
        if (r.status === 202) return setView({ kind: 'sent', email: value });
        if (r.status === 503) return setError(`Online requests aren’t available right now. Email ${ARAMO_SIGN_IDENTITY.privacyEmail} instead.`);
        if (r.status === 429) return setError('Too many requests from this connection. Try again later.');
        setError('We couldn’t send your request. Try again.');
      })
      .catch(() => setError('We couldn’t send your request. Check your connection and try again.'))
      .finally(() => setBusy(false));
  };

  if (view.kind === 'verifying') {
    return (
      <Frame testId="delete-account-verifying">
        <p className="su-hint" role="status">
          Confirming your request…
        </p>
      </Frame>
    );
  }
  if (view.kind === 'invalid') {
    return (
      <Frame testId="delete-account-invalid">
        <Tile tone="amber" icon="warn" />
        <CardTitle title="This link can’t be used" sub="Links work once, for one hour. Start a new request below, or check one you already made." />
        <PrimaryBtn block onClick={() => setView({ kind: 'form' })}>
          Start a new request
        </PrimaryBtn>
        <AppIdentity />
      </Frame>
    );
  }
  if (view.kind === 'request') {
    return (
      <Frame testId="delete-account-request">
        <Tile tone="green" icon="check" />
        <CardTitle title="We have your request" sub="Your email address is confirmed. The Aramo privacy team handles your request and answers within 30 days." />
        <PrivacyRequestResult request={view.request} />
        <AppIdentity />
      </Frame>
    );
  }
  if (view.kind === 'sent') {
    return (
      <Frame testId="delete-account-sent">
        <Tile tone="blue" icon="mail" />
        <CardTitle
          title="Check your email"
          sub={`If ${view.email} can receive email, we sent it a link to confirm the request. The link works once, for one hour. Nothing happens until you open it.`}
        />
        <AppIdentity />
      </Frame>
    );
  }
  return (
    <Frame testId="delete-account-form">
      <Tile tone="red" icon="shield" />
      <CardTitle
        title="Privacy and account requests"
        sub="Ask us to see, copy, correct or delete your personal information, or to delete your Personal Aramo Sign account. You don’t need the app or to sign in: we confirm your email address first."
      />
      <form className="su-stack" onSubmit={submit} noValidate>
        <div className="su-field">
          <span className="su-label" id="privacy-type-label" style={{ marginBottom: 8 }}>
            What would you like?
          </span>
          <div className="su-reasons" role="radiogroup" aria-labelledby="privacy-type-label">
            {PRIVACY_TYPES.map((t, i) => (
              <Button
                key={t.key}
                unstyled
                ref={(el) => {
                  refs.current[t.key] = el;
                }}
                className="su-reason"
                role="radio"
                aria-checked={type === t.key}
                tabIndex={type === t.key ? 0 : -1}
                onClick={() => setType(t.key)}
                onKeyDown={(e) => {
                  const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
                  if (d === 0) return;
                  e.preventDefault();
                  const next = PRIVACY_TYPES[(i + d + PRIVACY_TYPES.length) % PRIVACY_TYPES.length];
                  if (next === undefined) return;
                  setType(next.key);
                  refs.current[next.key]?.focus();
                }}
                data-testid={`privacy-type-${t.key}`}
              >
                <span className="su-type__radio" aria-hidden="true" />
                <span>
                  <span className="su-reason__label">{t.label}</span>
                  <span className="su-reason__sub">{t.sub}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
        <SuField id="privacy-email" label="Your email" help="The email you use for Aramo Sign, or the one signing requests were sent to.">
          <SuInput id="privacy-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-testid="privacy-email" />
        </SuField>
        {error !== null ? <Alert>{error}</Alert> : null}
        <PrimaryBtn type="submit" block disabled={busy} data-testid="privacy-submit">
          {busy ? 'Sending…' : 'Email me a confirmation link'}
        </PrimaryBtn>
      </form>
      <p className="su-hint">
        Signed in? Personal account owners can also delete their account in the app (Account → Delete account) or in Settings; an account from an
        organization uses Privacy requests there.
      </p>
      <WhatHappens />
      <StatusLookup onFound={(r) => setView({ kind: 'request', request: r })} />
      <AppIdentity />
    </Frame>
  );
}
