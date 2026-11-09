import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { AuthShell, resolveAuthProduct, type AuthProduct } from './AuthShell';
import { authPath, getAuthConsumer } from './consumer';
import { FEDERATED_IDPS, PROVIDER_NAME, parseLinkFragment } from './link';
import { PendingLinkPanel } from './PendingLinkPanel';
import { ProviderButton } from './ProviderButton';
import { MICROSOFT_SIGN_OUT_URL, loginUrl, logout, type FederatedIdp } from './session';

// AUTH-SIGNIN-1 §3.2 — the ONE Aramo-branded sign-in screen every Cognito-backed
// app serves at its own `/login` (ATS, App Home, Sign, Platform console). Visual
// design and copy follow the PO's sign-in prototype ("Aramo Sign In", Claude
// Design, 2026-10-20).
//
//   - Asks the auth-service which providers this host offers (login-options) and
//     shows one button per provider, Microsoft first. If that call fails, every
//     provider's button is shown: a UI fallback only — the auth-service still enforces a
//     tenant's provider at the callback (R1/R4).
//   - A button goes to `/auth/<consumer>/login?idp=…&return_to=…`, which sends
//     the browser straight to Google, Microsoft or Apple (no Cognito screen).
//   - `?error=CODE` (the callback's failure redirect) renders the matching error
//     screen. TENANT_ACCESS_DENIED keeps the wrong-account recovery (account
//     picker, sign out, sign out of Microsoft); the provider-policy reasons say
//     to use the organization's provider.
//   - `?consumer=` is honoured only from an allowlist (§3.2.1).
//   - Performs NO automatic navigation.
//   - Apple Go-Live W3 — Apple is the third provider (Microsoft, Google, Apple).
//   - Apple Go-Live A1 L-7 — a pending link (`#link=<handle>&idp=<p>` in the URL
//     fragment, with reason `idp_identity_conflict` or `user_not_provisioned`)
//     shows the L-3 path 3 / path 2 panel. The handle is read once, kept in
//     memory and stripped from the address bar.
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
  /**
   * Account-creation links (Aramo Sign: self-service sign-up), shown under the
   * sign-in buttons and on the "no Aramo account" screen. The app decides which
   * links exist (e.g. only while that sign-up is switched on).
   */
  accountLinks?: ReactNode;
  /**
   * Apple Go-Live A1 L-3 path 2 — "Create a new account", shown on the
   * no-account pending-link panel (Aramo Sign host only).
   */
  newAccountAction?: ReactNode;
  // Test seams.
  search?: string;
  hash?: string;
  onNavigate?: (url: string) => void;
  onSignOut?: () => void;
  fetchLoginOptions?: (consumer: string) => Promise<unknown>;
}

const PROVIDER_ORDER: readonly FederatedIdp[] = FEDERATED_IDPS;
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
  if (error === 'VALIDATION_ERROR' && reason === 'idp_email_unverified') {
    // The PreSignUp trigger refused an identity whose provider has not verified
    // its email (a Microsoft account with no mailbox, `xms_edov` false). Checked
    // before the per-app copy: an app's generic VALIDATION_ERROR copy (the
    // platform console's "Your session ended.") would hide the cause.
    return {
      tone: 'amber',
      icon: ICON.warn,
      title: 'Your Microsoft account’s email isn’t verified',
      body: 'Microsoft didn’t confirm an email address for this account, so we can’t sign you in with it. This usually means the work account has no mailbox.',
      note: 'Ask your administrator to give the account a mailbox, then try again. Or use another sign-in method.',
      actions: ['providers', 'different-account'],
    };
  }
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
  accountLinks,
  newAccountAction,
  search,
  hash,
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

  // A1 L-2/L-7 — read the pending link once, keep it in memory only, and strip
  // the fragment so the handle doesn't stay in the address bar or history.
  const routerNavigate = useNavigate();
  const [pendingLink] = useState(() => parseLinkFragment(hash ?? location.hash));
  useEffect(() => {
    if (/(^|[#&])link=/.test(location.hash)) {
      routerNavigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true });
    }
    // Once, on mount.
  }, []);
  const linkKind =
    pendingLink === null ? null : reason === 'idp_identity_conflict' ? 'conflict' : reason === 'user_not_provisioned' ? 'unprovisioned' : null;

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
        <ProviderButton key={idp} idp={idp} testId={`signin-${idp}`} onClick={() => navigate(loginUrl({ idp, consumer, returnTo }))} />
      ))
    );

  if (pendingLink !== null && linkKind !== null) {
    return (
      <AuthShell product={p}>
        <PendingLinkPanel
          kind={linkKind}
          link={pendingLink}
          providers={providers}
          consumer={consumer}
          returnTo={returnTo}
          navigate={navigate}
          {...(newAccountAction !== undefined ? { newAccount: newAccountAction } : {})}
        />
      </AuthShell>
    );
  }

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
        {error === 'INSUFFICIENT_PERMISSIONS' && accountLinks !== undefined ? accountLinks : null}
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
              : single === 'apple'
                ? 'Sign-in through your Apple ID. Aramo never sees your password.'
                : 'Single sign-on through your organization’s Google Workspace account. Aramo never sees your password.'}
          </span>
        </div>
      ) : null}
      {signerNote && single === null ? (
        <div className="aramo-auth__aside">
          <b>Signing a document someone sent you?</b> Open the link in your email. You don’t need an Aramo account.
        </div>
      ) : null}
      {accountLinks ?? null}
    </AuthShell>
  );
}
