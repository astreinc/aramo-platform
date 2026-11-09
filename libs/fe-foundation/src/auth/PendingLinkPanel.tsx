import { useState, type FormEvent, type ReactNode } from 'react';

import { PROVIDER_NAME, startLinkEmail, verifyLinkEmail, type PendingLink } from './link';
import { ProviderButton } from './ProviderButton';
import { loginUrl, type FederatedIdp } from './session';

// Apple Go-Live A1 L-3 / L-7 (web) — the /login panels for a pending link.
//
//   - Path 3, `idp_identity_conflict`: the provider shared the email of an
//     existing account. "Confirm it's you": sign in with a provider the account
//     already uses (proof a) or enter a code sent to the account email (proof b).
//   - Path 2, `user_not_provisioned`: no account uses this provider identity
//     (for example an Apple relay address). "I already have an account" → proof
//     (a) or (b) with the account email typed in; or "Create a new account".
//
// The handle lives in memory only (the page stripped it from the URL). Nothing
// here signs anyone in: after a verified code the user restarts sign-in with the
// new provider, which now resolves by subject (A1 L-4).

export type PendingLinkKind = 'conflict' | 'unprovisioned';

const ICON_PERSON = 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0';
const ICON_CHECK = 'M20 6 9 17l-5-5';
const ICON_LINK = 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7';

function Tile({ tone, icon }: { tone: 'amber' | 'grey' | 'green' | 'blue'; icon: string }) {
  return (
    <span className={`aramo-auth__tile aramo-auth__tile--${tone}`}>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={icon} />
      </svg>
    </span>
  );
}

type Stage =
  | { k: 'choose' }
  | { k: 'code'; email: string | null }
  | { k: 'linked' }
  | { k: 'expired' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PendingLinkPanel({
  kind,
  link,
  providers,
  consumer,
  returnTo,
  navigate,
  newAccount,
}: {
  kind: PendingLinkKind;
  link: PendingLink;
  /** login-options for this host (null while loading). */
  providers: FederatedIdp[] | null;
  consumer: string;
  returnTo: string | null;
  navigate: (url: string) => void;
  /** Path 2 "Create a new account" (Aramo Sign host only). */
  newAccount?: ReactNode;
}) {
  const name = PROVIDER_NAME[link.idp];
  const [stage, setStage] = useState<Stage>({ k: 'choose' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Proof (a): any provider this host offers other than the one being added.
  const others = (providers ?? []).filter((p) => p !== link.idp);
  const proofButtons =
    providers === null ? (
      <p className="aramo-auth__loading" role="status">
        Loading sign-in options…
      </p>
    ) : (
      others.map((idp) => (
        <ProviderButton
          key={idp}
          idp={idp}
          testId={`link-proof-${idp}`}
          onClick={() => navigate(loginUrl({ idp, consumer, returnTo, link: link.handle }))}
        />
      ))
    );

  const send = async (to: string | null) => {
    setBusy(true);
    setError(null);
    const ok = await startLinkEmail(link.handle, to ?? undefined);
    setBusy(false);
    if (!ok) {
      setError('We couldn’t send a code right now. Try again in a minute.');
      return;
    }
    setCode('');
    setStage({ k: 'code', email: to });
  };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'unprovisioned' && !EMAIL_RE.test(email.trim())) {
      setError('Enter the email address of your Aramo account.');
      return;
    }
    void send(kind === 'unprovisioned' ? email.trim() : null);
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await verifyLinkEmail(link.handle, code.trim());
    setBusy(false);
    if (r.ok) {
      setStage({ k: 'linked' });
      return;
    }
    switch (r.reason) {
      case 'code_invalid':
        setError(
          r.attemptsRemaining === null
            ? 'That code isn’t right. Check it and try again.'
            : `That code isn’t right. ${r.attemptsRemaining} ${r.attemptsRemaining === 1 ? 'try' : 'tries'} left.`,
        );
        return;
      case 'code_expired':
        setError('That code has expired. Send a new one.');
        return;
      case 'code_attempts_exceeded':
      case 'link_expired':
        setStage({ k: 'expired' });
        return;
      default:
        setError('We couldn’t check the code. Try again.');
    }
  };

  if (stage.k === 'linked') {
    return (
      <div data-testid="link-linked">
        <div role="status">
          <Tile tone="green" icon={ICON_CHECK} />
          <h1 className="aramo-auth__title">{`${name} is connected`}</h1>
          <p className="aramo-auth__sub">{`You can now sign in to your Aramo account with ${name}.`}</p>
        </div>
        <div className="aramo-auth__actions">
          <ProviderButton idp={link.idp} verb="Sign in" testId="link-signin" onClick={() => navigate(loginUrl({ idp: link.idp, consumer, returnTo }))} />
        </div>
      </div>
    );
  }

  if (stage.k === 'expired') {
    return (
      <div data-testid="link-expired">
        <div role="alert">
          <Tile tone="grey" icon={ICON_LINK} />
          <h1 className="aramo-auth__title aramo-auth__title--error">This request has expired</h1>
          <p className="aramo-auth__sub">{`For your security, connecting ${name} has to start again. Sign in with ${name} to try again.`}</p>
        </div>
        <div className="aramo-auth__actions">
          <ProviderButton idp={link.idp} onClick={() => navigate(loginUrl({ idp: link.idp, consumer, returnTo }))} />
        </div>
      </div>
    );
  }

  if (stage.k === 'code') {
    return (
      <div data-testid="link-code">
        <Tile tone="blue" icon={ICON_LINK} />
        <h1 className="aramo-auth__title">Check your email</h1>
        <p className="aramo-auth__sub">
          {stage.email === null
            ? 'We sent a 6-digit code to the email address of your Aramo account. It works for 10 minutes.'
            : `If ${stage.email} belongs to an Aramo account, we sent a 6-digit code to it. It works for 10 minutes.`}
        </p>
        <form className="aramo-auth__actions" onSubmit={(e) => void submitCode(e)} noValidate>
          <div>
            <label className="aramo-auth__label" htmlFor="link-code-input">
              Code
            </label>
            <input
              id="link-code-input"
              className="aramo-auth__input aramo-auth__input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, ''));
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? 'link-code-error' : undefined}
              data-testid="link-code-input"
            />
            {error !== null ? (
              <p className="aramo-auth__field-error" id="link-code-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <button type="submit" className="aramo-auth__btn aramo-auth__btn--primary" disabled={busy} data-testid="link-code-submit">
            {busy ? 'Checking…' : `Confirm and connect ${name}`}
          </button>
          <button type="button" className="aramo-auth__btn" disabled={busy} onClick={() => void send(stage.email)} data-testid="link-code-resend">
            Send a new code
          </button>
        </form>
      </div>
    );
  }

  const emailBlock =
    kind === 'conflict' ? (
      <>
        <button type="button" className="aramo-auth__btn" disabled={busy} onClick={() => void send(null)} data-testid="link-email-start">
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
        {error !== null ? (
          <p className="aramo-auth__field-error" role="alert">
            {error}
          </p>
        ) : null}
      </>
    ) : (
      <form onSubmit={submitEmail} noValidate className="aramo-auth__actions" style={{ marginTop: 0 }}>
        <div>
          <label className="aramo-auth__label" htmlFor="link-email-input">
            Email of your Aramo account
          </label>
          <input
            id="link-email-input"
            className="aramo-auth__input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? 'link-email-error' : undefined}
            data-testid="link-email-input"
          />
          {error !== null ? (
            <p className="aramo-auth__field-error" id="link-email-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <button type="submit" className="aramo-auth__btn" disabled={busy} data-testid="link-email-start">
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
      </form>
    );

  if (kind === 'conflict') {
    return (
      <div data-testid="link-conflict">
        <div role="alert">
          <Tile tone="amber" icon={ICON_PERSON} />
          <h1 className="aramo-auth__title aramo-auth__title--error">You already have an Aramo account</h1>
          <p className="aramo-auth__sub">{`Confirm it’s you to add ${name} as a way to sign in.`}</p>
        </div>
        <div className="aramo-auth__actions">
          {proofButtons}
          {others.length > 0 ? <div className="aramo-auth__or">or</div> : null}
          {emailBlock}
        </div>
        <div className="aramo-auth__note">
          <span>{`We add ${name} only after you confirm. Until then, nothing changes on your account.`}</span>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="link-unprovisioned">
      <div role="alert">
        <Tile tone="grey" icon={ICON_PERSON} />
        <h1 className="aramo-auth__title aramo-auth__title--error">{`No Aramo account uses this ${name} ${link.idp === 'apple' ? 'ID' : 'account'} yet`}</h1>
        <p className="aramo-auth__sub">
          {link.idp === 'apple'
            ? 'Your Apple ID may not have shared the email address your Aramo account uses.'
            : `Your ${name} account doesn’t match an Aramo account.`}
        </p>
      </div>
      <h2 className="aramo-auth__section-title">I already have an account. Connect it</h2>
      <div className="aramo-auth__actions" style={{ marginTop: 0 }}>
        {proofButtons}
        {others.length > 0 ? <div className="aramo-auth__or">or</div> : null}
        {emailBlock}
      </div>
      {newAccount !== undefined ? (
        <>
          <h2 className="aramo-auth__section-title">New to Aramo?</h2>
          {newAccount}
        </>
      ) : null}
      {link.idp === 'apple' ? (
        <div className="aramo-auth__note">
          {/* Apple Go-Live R-3 — a relay address can't match a Business account. */}
          <span>Using Aramo for work? Your Apple ID didn’t share your work email. Choose Share My Email, or sign in with Google or Microsoft.</span>
        </div>
      ) : null}
    </div>
  );
}
