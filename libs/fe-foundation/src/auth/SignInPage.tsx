import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { Button } from '../components/Button';
import { InlineAlert } from '../components/InlineAlert';
import { WrongAccountRecovery } from '../components/WrongAccountRecovery';

import { authPath, getAuthConsumer } from './consumer';
import { loginUrl, type FederatedIdp } from './session';

import './sign-in.css';

// AUTH-SIGNIN-1 §3.2 — the ONE Aramo-branded sign-in screen every Cognito-backed
// app serves at its own `/login` (ATS, App Home, Sign, Platform console).
//
//   - Asks the auth-service which providers this host offers (login-options) and
//     shows one button per provider, Microsoft first. If that call fails, both
//     buttons are shown: a UI fallback only — the auth-service still enforces a
//     tenant's provider at the callback (R1/R4).
//   - A button goes to `/auth/<consumer>/login?idp=…&return_to=…`, which sends
//     the browser straight to Google or Microsoft (no Cognito screen).
//   - `?error=CODE` (the callback's failure redirect) shows a message with the
//     buttons; TENANT_ACCESS_DENIED keeps the wrong-account recovery page, except
//     the provider-policy reasons, which say to use the organization's provider.
//   - `?consumer=` is honoured only from an allowlist (§3.2.1): the configured
//     consumer, or — for the two tenant-host consumers — the other one.
//   - Performs NO automatic navigation.

export interface SignInErrorCopy {
  title: string;
  message: string;
  // false → no sign-in buttons (signing in again cannot help).
  retry: boolean;
}

export interface SignInPageProps {
  /** What the user is signing in to, e.g. "Aramo ATS". */
  productName?: string;
  /** Per-app copy for specific error codes (overrides the defaults). */
  errorCopy?: Readonly<Record<string, SignInErrorCopy>>;
  /** Extra action rendered under a TENANT_CAPABILITY_NOT_ENTITLED message. */
  notEntitledAction?: ReactNode;
  // Test seams.
  search?: string;
  onNavigate?: (url: string) => void;
  fetchLoginOptions?: (consumer: string) => Promise<unknown>;
}

const PROVIDER_ORDER: readonly FederatedIdp[] = ['microsoft', 'google'];
const TENANT_HOST_CONSUMERS: ReadonlySet<string> = new Set(['recruiter', 'org']);
const IDP_POLICY_REASONS: ReadonlySet<string> = new Set(['idp_not_permitted_for_tenant', 'idp_identity_conflict']);
const OPTIONS_TIMEOUT_MS = 5000;

const DEFAULT_ERROR_COPY: Readonly<Record<string, SignInErrorCopy>> = {
  TENANT_SUSPENDED: {
    title: 'Workspace suspended',
    message:
      'This workspace has been suspended, so sign-in is paused. Please contact your provider to restore access.',
    retry: true,
  },
  TENANT_CLOSED: {
    title: 'Workspace closed',
    message:
      'This workspace has been closed and is no longer available. Please contact your provider if you believe this is a mistake.',
    retry: false,
  },
  TENANT_CAPABILITY_NOT_ENTITLED: {
    title: 'Product not available',
    message:
      "This product is not included in your organization's Aramo subscription. Contact your organization administrator.",
    retry: false,
  },
};

const GENERIC_ERROR: SignInErrorCopy = {
  title: 'Sign-in failed',
  message: 'We could not complete your sign-in. Please try again, and contact your administrator if the problem continues.',
  retry: true,
};

const IDP_POLICY_ERROR: SignInErrorCopy = {
  title: 'Use your organization’s sign-in',
  message:
    'Your organization signs in with a different provider. Continue with the provider and work account your organization uses for Aramo.',
  retry: true,
};

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

function AramoMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--c-text, #1C1917)" />
      <g stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round">
        <line x1="43" y1="32" x2="56" y2="32" />
        <line x1="32" y1="43" x2="32" y2="56" />
        <line x1="24.2" y1="39.8" x2="15" y2="49" />
        <line x1="21" y1="32" x2="8" y2="32" />
        <line x1="24.2" y1="24.2" x2="15" y2="15" />
        <line x1="32" y1="21" x2="32" y2="8" />
        <line x1="39.8" y1="39.8" x2="49" y2="49" />
      </g>
      <line x1="39.8" y1="24.2" x2="54.5" y2="9.5" stroke="#d97757" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="6" fill="#FFFFFF" />
    </svg>
  );
}

const PROVIDER_LABEL: Record<FederatedIdp, string> = {
  microsoft: 'Continue with Microsoft',
  google: 'Continue with Google',
};

export function SignInPage({
  productName,
  errorCopy,
  notEntitledAction,
  search,
  onNavigate,
  fetchLoginOptions,
}: SignInPageProps) {
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

  if (error === 'TENANT_ACCESS_DENIED' && (reason === null || !IDP_POLICY_REASONS.has(reason))) {
    return (
      <main className="aramo-signin" data-testid="aramo-signin">
        <div className="aramo-signin__panel aramo-signin__panel--wide">
          <WrongAccountRecovery
            onSelectAccount={() => navigate(loginUrl({ selectAccount: true, consumer, returnTo: null }))}
          />
        </div>
      </main>
    );
  }

  const copy: SignInErrorCopy | null =
    error === null
      ? null
      : error === 'TENANT_ACCESS_DENIED'
        ? IDP_POLICY_ERROR
        : (errorCopy?.[error] ?? DEFAULT_ERROR_COPY[error] ?? GENERIC_ERROR);
  const showButtons = copy === null || copy.retry;

  return (
    <main className="aramo-signin" data-testid="aramo-signin">
      <div className="aramo-signin__panel">
        <div className="aramo-signin__brand">
          <AramoMark />
          <span className="aramo-signin__wordmark">Aramo</span>
        </div>
        <h1 className="aramo-signin__title">{copy === null ? 'Sign in' : copy.title}</h1>
        {copy === null ? (
          <p className="aramo-signin__lede">
            {productName === undefined ? 'Use your work account to continue.' : `Use your work account to continue to ${productName}.`}
          </p>
        ) : (
          <div className="aramo-signin__alert">
            <InlineAlert variant="error">{copy.message}</InlineAlert>
          </div>
        )}
        {showButtons ? (
          <div className="aramo-signin__providers">
            {providers === null ? (
              <p className="aramo-signin__loading" role="status">
                Loading sign-in options…
              </p>
            ) : (
              providers.map((idp) => (
                <Button
                  key={idp}
                  unstyled
                  className="aramo-signin__provider"
                  data-testid={`signin-${idp}`}
                  onClick={() => navigate(loginUrl({ idp, consumer, returnTo }))}
                >
                  {idp === 'microsoft' ? <MicrosoftLogo /> : <GoogleLogo />}
                  <span>{PROVIDER_LABEL[idp]}</span>
                </Button>
              ))
            )}
          </div>
        ) : null}
        {error === 'TENANT_CAPABILITY_NOT_ENTITLED' && notEntitledAction !== undefined ? (
          <div className="aramo-signin__action">{notEntitledAction}</div>
        ) : null}
        <p className="aramo-signin__footer">Secured by Aramo</p>
      </div>
    </main>
  );
}
