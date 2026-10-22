import type { ReactNode } from 'react';

import './sign-in.css';

// AUTH-SIGNIN-1 §3.2 — the Aramo authentication frame shared by the sign-in and
// signed-out screens, per the PO's sign-in prototype ("Aramo Sign In", Claude
// Design, 2026-10-20): a brand panel (product eyebrow, name, tagline) beside the
// card on wide screens; a compact brand bar above it on narrow ones.

export interface AuthProduct {
  /** Product name, e.g. "Aramo ATS". */
  name: string;
  /** Small uppercase label above the name, e.g. "ARAMO ATS". */
  eyebrow: string;
  tagline: string;
  /** Sign-in card heading. */
  heading: string;
  /** Sign-in card subheading. */
  sub: string;
}

// The four Cognito-backed apps (copy from the prototype).
export const AUTH_PRODUCTS = {
  ats: {
    name: 'Aramo ATS',
    eyebrow: 'ARAMO ATS',
    tagline: 'Recruit, qualify and place talent in one workspace.',
    heading: 'Welcome back',
    sub: 'Sign in to Aramo ATS with your work account.',
  },
  sign: {
    name: 'Aramo Sign',
    eyebrow: 'ARAMO SIGN',
    tagline: 'Send, manage and sign agreements with a full audit trail.',
    heading: 'Welcome to Aramo Sign',
    sub: 'Sign in to send, manage, and sign documents.',
  },
  home: {
    name: 'Aramo',
    eyebrow: 'ARAMO APP HOME',
    tagline: 'Your Aramo apps and your organization, in one place.',
    heading: 'Welcome back',
    sub: 'Sign in to Aramo with your work account.',
  },
  platform: {
    name: 'Aramo Platform',
    eyebrow: 'ARAMO PLATFORM ADMIN',
    tagline: 'Tenant and platform administration. Restricted to Aramo staff.',
    heading: 'Aramo Platform administration',
    sub: 'Sign in with your Aramo staff account.',
  },
} as const satisfies Record<string, AuthProduct>;

const GENERIC_PRODUCT: AuthProduct = {
  name: 'Aramo',
  eyebrow: 'ARAMO',
  tagline: 'Your Aramo apps and your organization, in one place.',
  heading: 'Welcome back',
  sub: 'Sign in with your work account.',
};

export function resolveAuthProduct(product: AuthProduct | undefined): AuthProduct {
  return product ?? GENERIC_PRODUCT;
}

const MARK_SPOKES = (
  <g stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round">
    <line x1="43" y1="32" x2="56" y2="32" />
    <line x1="32" y1="43" x2="32" y2="56" />
    <line x1="24.2" y1="39.8" x2="15" y2="49" />
    <line x1="21" y1="32" x2="8" y2="32" />
    <line x1="24.2" y1="24.2" x2="15" y2="15" />
    <line x1="32" y1="21" x2="32" y2="8" />
    <line x1="39.8" y1="39.8" x2="49" y2="49" />
  </g>
);

export function AramoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {MARK_SPOKES}
      <line x1="39.8" y1="24.2" x2="54.5" y2="9.5" stroke="#d97757" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="6" fill="#FFFFFF" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
    </svg>
  );
}

export interface AuthShellProps {
  product: AuthProduct;
  children: ReactNode;
  /** Replaces the brand panel's footer line (default: the identity-provider note). */
  idpNote?: ReactNode;
  /** Accessible name of the card region (default "Sign in"). */
  cardLabel?: string;
  /** Extra class on the card, for a product-specific card width or padding. */
  cardClassName?: string;
  /** Extra class on the root frame. */
  className?: string;
}

// All optional props are additive: omitted, the frame renders exactly as the
// sign-in and signed-out screens always have.
export function AuthShell({ product, children, idpNote, cardLabel, cardClassName, className }: AuthShellProps) {
  return (
    <div className={className !== undefined ? `aramo-auth ${className}` : 'aramo-auth'} data-testid="aramo-signin">
      <aside className="aramo-auth__brand">
        <svg className="aramo-auth__watermark" width="420" height="420" viewBox="0 0 64 64" aria-hidden="true">
          {MARK_SPOKES}
          <line x1="39.8" y1="24.2" x2="54.5" y2="9.5" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" />
          <circle cx="32" cy="32" r="6" fill="#FFFFFF" />
        </svg>
        <div className="aramo-auth__logo">
          <AramoMark size={30} />
          <span className="aramo-auth__wordmark">
            aramo<span className="aramo-auth__wordmark-tld">.ai</span>
          </span>
        </div>
        <div className="aramo-auth__pitch">
          <div className="aramo-auth__eyebrow">{product.eyebrow}</div>
          <div className="aramo-auth__product">{product.name}</div>
          <div className="aramo-auth__tagline">{product.tagline}</div>
        </div>
        <div className="aramo-auth__idp-note">
          <ShieldIcon />
          {idpNote ?? <>Sign-in is handled by your organization&apos;s identity provider.</>}
        </div>
      </aside>
      <div className="aramo-auth__side">
        <div className="aramo-auth__bar">
          <AramoMark size={24} />
          <span>{product.name}</span>
        </div>
        <main className="aramo-auth__main">
          <div className={cardClassName !== undefined ? `aramo-auth__card ${cardClassName}` : 'aramo-auth__card'} role="region" aria-label={cardLabel ?? 'Sign in'} aria-live="polite">
            {children}
          </div>
        </main>
        <footer className="aramo-auth__footer">
          <span>Secured by Aramo</span>
          <a href="https://aramo.ai/legal/privacy/" rel="noopener noreferrer">
            Privacy
          </a>
          <a href="https://aramo.ai/legal/terms/" rel="noopener noreferrer">
            Terms
          </a>
          <a href="https://aramo.ai/company/contact.html" rel="noopener noreferrer">
            Help
          </a>
        </footer>
      </div>
    </div>
  );
}
