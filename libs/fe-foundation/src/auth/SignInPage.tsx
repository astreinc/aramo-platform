import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { AuthShell, resolveAuthProduct, type AuthProduct } from './AuthShell';
import { authPath, getAuthConsumer } from './consumer';
import { MICROSOFT_SIGN_OUT_URL, loginUrl, logout, type FederatedIdp } from './session';

// AUTH-SIGNIN-1 §3.2 — the ONE Aramo-branded sign-in screen every Cognito-backed
// app serves at its own `/login` (ATS, App Home, Sign, Platform console). Visual
// design and copy follow the PO's sign-in prototype ("Aramo Sign In", Claude
// Design, 2026-10-20).
//
//   - Asks the auth-service which providers this host offers (login-options) and
//     shows one button per provider, Microsoft first. If that call fails, both
//     buttons are shown: a UI fallback only — the auth-service still enforces a
//     tenant's provider at the callback (R1/R4).
//   - A button goes to `/auth/<consumer>/login?idp=…&return_to=…`, which sends
//     the browser straight to Google or Microsoft (no Cognito screen).
//   - `?error=CODE` (the callback's failure redirect) renders the matching error
//     screen. TENANT_ACCESS_DENIED keeps the wrong-account recovery (account
//     picker, sign out, sign out of Microsoft); the provider-policy reasons say
//     to use the organization's provider.
//   - `?consumer=` is honoured only from an allowlist (§3.2.1).
//   - Performs NO automatic navigation.
//
// Deliberately NOT built (need backend/directive work): the organization name
// and initials header, and "find your organization" by work email.

export interface SignInErrorCopy {
  title: string;
  message: string;
  // false → no sign-in buttons (signing in again cannot help).
  retry: boolean;
}

export interface SignInPageProps {
  /** Product presentation (AUTH_PRODUCTS.ats / .sign / .home / .platform). */
  product?: AuthProduct;
  /** Per-app copy for specific error codes (overrides the defaults). */
  errorCopy?: Readonly<Record<string, SignInErrorCopy>>;
  /** Extra action rendered on the TENANT_CAPABILITY_NOT_ENTITLED screen. */
  notEntitledAction?: ReactNode;
  /** Show the "signing a document someone sent you?" aside (Aramo Sign). */
  signerNote?: boolean;
  // Test seams.
  search?: string;
  onNavigate?: (url: string) => void;
  onSignOut?: () => void;
  fetchLoginOptions?: (consumer: string) => Promise<unknown>;
}

const PROVIDER_ORDER: readonly FederatedIdp[] = ['microsoft', 'google'];
const PROVIDER_NAME: Record<FederatedIdp, string> = { microsoft: 'Microsoft', google: 'Google' };
const TENANT_HOST_CONSUMERS: ReadonlySet<string> = new Set(['recruiter', 'org']);
const IDP_POLICY_REASONS: ReadonlySet<string> = new Set(['idp_not_permitted_for_tenant', 'idp_identity_conflict']);
const OPTIONS_TIMEOUT_MS = 5000;

/** §3.2.1 — the consumer this page signs in to: an allowlisted `?consumer=` or the configured one. */
export function allowedConsumer(requested: string | null, configured: string = getAuthConsumer()): string {
  if (requested === null || requested === configured) return configured;
  if (TENANT_HOST_CONSUMERS.has(configured) && TENANT_HOST_CONSUMERS.has(requested)) return requested;
  return configured;
}

/** A same-host relative deep link, or null. The auth-service re-validates it. */
export function safeReturnTo(raw: string | null): string | null {
  if (raw === null || raw.length === 0 || raw.length > 2000) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

/** login-options body → providers to show, in display order; null when unusable. */
export function providersFrom(body: unknown): FederatedIdp[] | null {
  const list = (body as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) return null;
  const wanted = new Set(list.filter((p): p is string => typeof p === 'string').map((p) => p.toLowerCase()));
  const shown = PROVIDER_ORDER.filter((p) => wanted.has(p));
  return shown.length > 0 ? shown : null;
}

async function defaultFetchLoginOptions(consumer: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OPTIONS_TIMEOUT_MS);
  try {
    const res = await fetch(authPath('login-options', consumer), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`login-options ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const ICON = {
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  cross: 'M18 6 6 18M6 6l12 12',
  denied: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM9.5 9.5l5 5M14.5 9.5l-5 5',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  shieldInfo: 'M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM12 9v4M12 16h.01',
} as const;

type Tone = 'amber' | 'grey' | 'red' | 'blue';
type ErrorAction = 'providers' | 'different-account' | 'sign-out' | 'not-entitled';

interface ErrorScreen {
  tone: Tone;
  icon: string;
  title: string;
  body: string;
  note?: ReactNode;
  actions: readonly ErrorAction[];
}

function errorScreen(
  error: string,
  reason: string | null,
  productName: string,
  providers: FederatedIdp[] | null,
  errorCopy: Readonly<Record<string, SignInErrorCopy>> | undefined,
  signerNote: boolean,
): ErrorScreen {
  const override = errorCopy?.[error];
  if (override !== undefined) {
    return {
      tone: override.retry ? 'amber' : 'blue',
      icon: override.retry ? ICON.warn : ICON.shieldInfo,
      title: override.title,
      body: override.message,
      actions: override.retry ? ['providers'] : error === 'TENANT_CAPABILITY_NOT_ENTITLED' ? ['not-entitled'] : [],
    };
  }
  if (error === 'TENANT_ACCESS_DENIED' && reason !== null && IDP_POLICY_REASONS.has(reason)) {
    const first = providers !== null && providers.length === 1 ? providers[0] : undefined;
    const only = first === undefined ? null : PROVIDER_NAME[first];
    return {
      tone: 'amber',
      icon: ICON.warn,
      title: only === null ? 'Use your organization’s sign-in provider' : `Your organization uses ${only} for sign-in.`,
      body:
        only === null
          ? `Continue with the provider and work account your organization uses for ${productName}.`
          : `Continue with your ${only} work account to open ${productName}.`,
      note: 'An account from a different provider can’t open your organization, even if the email address is the same.',
      actions: ['providers', 'different-account'],
    };
  }
  switch (error) {
    case 'TENANT_ACCESS_DENIED':
      // Host-binding SSO recovery: the signed-in account does not belong to this
      // host. Names no tenant, workspace or account.
      return {
        tone: 'red',
        icon: ICON.denied,
        title: 'Signed in with a different account',
        body: 'The account you signed in with doesn’t have access here. This usually happens when another account is already signed in on this browser.',
        note: (
          <>
            If Microsoft keeps signing you in with the wrong account,{' '}
            <a href={MICROSOFT_SIGN_OUT_URL} rel="noopener noreferrer">
              sign out of Microsoft
            </a>{' '}
            and then sign in again.
          </>
        ),
        actions: ['different-account', 'sign-out'],
      };
    case 'INSUFFICIENT_PERMISSIONS':
      return {
        tone: 'grey',
        icon: ICON.person,
        title: 'We couldn’t find an Aramo account for you',
        body: 'Aramo doesn’t create accounts at sign-in. Ask your organization’s administrator to invite you.',
        note: signerNote ? 'Signing a document someone sent you? Open the link in your email. You don’t need an account.' : undefined,
        actions: ['different-account'],
      };
    case 'TENANT_CAPABILITY_NOT_ENTITLED':
      return {
        tone: 'blue',
        icon: ICON.shieldInfo,
        title: `You don’t have access to ${productName}`,
        body: `You’re signed in, but ${productName} isn’t enabled for your organization. Ask your administrator for access.`,
        actions: ['not-entitled', 'different-account'],
      };
    case 'TENANT_SUSPENDED':
      return {
        tone: 'amber',
        icon: ICON.warn,
        title: 'Workspace suspended',
        body: 'This workspace has been suspended, so sign-in is paused. Please contact your provider to restore access.',
        actions: ['providers'],
      };
    case 'TENANT_CLOSED':
      return {
        tone: 'grey',
        icon: ICON.cross,
        title: 'Workspace closed',
        body: 'This workspace has been closed and is no longer available. Please contact your provider if you believe this is a mistake.',
        actions: [],
      };
    case 'VALIDATION_ERROR':
      return reason === 'cognito_error'
        ? {
            tone: 'grey',
            icon: ICON.cross,
            title: 'Sign-in was canceled',
            body: 'The sign-in closed before it finished. Nothing was changed.',
            actions: ['providers'],
          }
        : {
            tone: 'grey',
            icon: ICON.cross,
            title: 'Sign-in was interrupted',
            body: 'The sign-in took too long or was started in another tab. Nothing was changed. Try again.',
            actions: ['providers'],
          };
    case 'INTERNAL_ERROR':
      return {
        tone: 'amber',
        icon: ICON.warn,
        title: 'Sign-in is temporarily unavailable',
        body: 'We couldn’t complete sign-in with your identity provider. This is usually brief. Try again in a minute.',
        actions: ['providers'],
      };
    default:
      return {
        tone: 'amber',
        icon: ICON.warn,
        title: 'Sign-in failed',
        body: 'We could not complete your sign-in. Please try again, and contact your administrator if the problem continues.',
        actions: ['providers'],
      };
  }
}

export function SignInPage({
  product,
  errorCopy,
  notEntitledAction,
  signerNote = false,
  search,
  onNavigate,
  onSignOut,
  fetchLoginOptions,
}: SignInPageProps) {
  const p = resolveAuthProduct(product);
  const location = useLocation();
  const params = new URLSearchParams(search ?? location.search);
  const error = params.get('error');
  const reason = params.get('reason');
  const configured = getAuthConsumer();
  const consumer = allowedConsumer(params.get('consumer'), configured);
  // A return_to belongs to the configured consumer's app; drop it when signing
  // in to a different (allowlisted) consumer.
  const returnTo = consumer === configured ? safeReturnTo(params.get('return_to')) : null;

  const [providers, setProviders] = useState<FederatedIdp[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (fetchLoginOptions ?? defaultFetchLoginOptions)(consumer)
      .then((body) => {
        if (!cancelled) setProviders(providersFrom(body) ?? [...PROVIDER_ORDER]);
      })
      .catch(() => {
        // R4 — UI fallback only; the backend still enforces the tenant's provider.
        if (!cancelled) setProviders([...PROVIDER_ORDER]);
      });
    return () => {
      cancelled = true;
    };
  }, [consumer, fetchLoginOptions]);

  const navigate = onNavigate ?? ((url: string) => window.location.assign(url));

  const providerButtons =
    providers === null ? (
      <p className="aramo-auth__loading" role="status">
        Loading sign-in options…
      </p>
    ) : (
      providers.map((idp) => (
        <button
          key={idp}
          type="button"
          className="aramo-auth__btn"
          data-testid={`signin-${idp}`}
          onClick={() => navigate(loginUrl({ idp, consumer, returnTo }))}
        >
          {idp === 'microsoft' ? <MicrosoftLogo /> : <GoogleLogo />}
          <span>{`Continue with ${PROVIDER_NAME[idp]}`}</span>
        </button>
      ))
    );

  if (error !== null) {
    const screen = errorScreen(error, reason, p.name, providers, errorCopy, signerNote);
    return (
      <AuthShell product={p}>
        <div role="alert">
          <span className={`aramo-auth__tile aramo-auth__tile--${screen.tone}`}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={screen.icon} />
            </svg>
          </span>
          <h1 className="aramo-auth__title aramo-auth__title--error">{screen.title}</h1>
          <p className="aramo-auth__sub">{screen.body}</p>
        </div>
        {screen.actions.length > 0 ? (
          <div className="aramo-auth__actions">
            {screen.actions.map((action) => {
              switch (action) {
                case 'providers':
                  return <div key={action} className="aramo-auth__actions" style={{ marginTop: 0 }}>{providerButtons}</div>;
                case 'different-account':
                  return (
                    <button
                      key={action}
                      type="button"
                      className="aramo-auth__btn"
                      onClick={() => navigate(loginUrl({ selectAccount: true, consumer, returnTo: null }))}
                    >
                      Sign in with a different account
                    </button>
                  );
                case 'sign-out':
                  return (
                    <button key={action} type="button" className="aramo-auth__btn" onClick={() => (onSignOut ? onSignOut() : void logout())}>
                      Sign out and start over
                    </button>
                  );
                case 'not-entitled':
                  return notEntitledAction === undefined ? null : <div key={action}>{notEntitledAction}</div>;
              }
            })}
          </div>
        ) : null}
        {screen.note !== undefined ? (
          <div className="aramo-auth__note">
            <span>{screen.note}</span>
          </div>
        ) : null}
      </AuthShell>
    );
  }

  const single = providers !== null && providers.length === 1 ? (providers[0] ?? null) : null;
  return (
    <AuthShell product={p}>
      <h1 className="aramo-auth__title">{p.heading}</h1>
      <p className="aramo-auth__sub">{p.sub}</p>
      {returnTo !== null ? (
        <div className="aramo-auth__return" data-testid="signin-return-note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5C6770" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />
          </svg>
          <span>After you sign in, you’ll return to where you left off.</span>
        </div>
      ) : null}
      <div className="aramo-auth__actions">{providerButtons}</div>
      {single !== null ? (
        <div className="aramo-auth__note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F7A4D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>
            {single === 'microsoft'
              ? 'Single sign-on through your organization’s Microsoft account. Aramo never sees your password.'
              : 'Single sign-on through your organization’s Google Workspace account. Aramo never sees your password.'}
          </span>
        </div>
      ) : null}
      {signerNote && single === null ? (
        <div className="aramo-auth__aside">
          <b>Signing a document someone sent you?</b> Open the link in your email. You don’t need an Aramo account.
        </div>
      ) : null}
    </AuthShell>
  );
}
