import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

// The Aramo app switcher (accepted App Home handoff §3; Settings & navigation
// change log A6/B1). A 36px icon button in the top bar opening a panel headed
// "Apps for <organization>". Rows come from the backend-authoritative product
// availability read (GET /v1/me/products) — the switcher never decides access:
// an available row is a link to the product's entry, where the product checks
// access again; an unavailable row is not a link at all. The external signer app
// (sign.aramo.ai/s/:token) is NEVER a row — it is reached only by a signing link.

export interface AppSwitcherItem {
  readonly key: string;
  readonly label: string;
  /** Secondary line ("You are here", "No access", …). */
  readonly sub: string;
  readonly icon: ReactNode;
  /** 'current' = this app; 'open' = navigable; 'unavailable' = not a link. */
  readonly state: 'current' | 'open' | 'unavailable';
  /** Router path inside the current SPA (preferred when the target is in it). */
  readonly to?: string;
  /** Full-navigation href (another SPA on this host). */
  readonly href?: string;
}

interface AppSwitcherProps {
  readonly organizationName: string | null;
  readonly items: readonly AppSwitcherItem[];
  /** Opens the panel from outside (e.g. the account menu's "Switch application"). */
  readonly openSignal?: number;
}

function AppsIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

export function AppSwitcher({ organizationName, items, openSignal }: AppSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const heading = organizationName ? `Apps for ${organizationName}` : 'Aramo apps';

  return (
    <div className="ar-switch" ref={ref}>
      <button
        type="button"
        className="ar-switch__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch application"
        title="Switch application"
        onClick={() => setOpen((o) => !o)}
      >
        <AppsIcon />
      </button>
      {open ? (
        <div className="ar-switch__panel" role="menu" aria-label={heading}>
          <div className="ar-switch__head">{heading}</div>
          {items.map((it) => {
            const body = (
              <>
                <span className="ar-switch__icon" aria-hidden="true">
                  {it.icon}
                </span>
                <span className="ar-switch__text">
                  <span className="ar-switch__label">{it.label}</span>
                  <span className="ar-switch__sub">{it.sub}</span>
                </span>
              </>
            );
            const cls = `ar-switch__row ar-switch__row--${it.state}`;
            if (it.state === 'unavailable') {
              return (
                <div key={it.key} className={cls} role="menuitem" aria-disabled="true" data-testid={`app-switch-${it.key}`}>
                  {body}
                </div>
              );
            }
            if (it.to !== undefined) {
              return (
                <RouterLink
                  key={it.key}
                  to={it.to}
                  className={cls}
                  role="menuitem"
                  aria-current={it.state === 'current' ? 'page' : undefined}
                  data-testid={`app-switch-${it.key}`}
                  onClick={() => setOpen(false)}
                >
                  {body}
                </RouterLink>
              );
            }
            return (
              <a
                key={it.key}
                href={it.href}
                className={cls}
                role="menuitem"
                aria-current={it.state === 'current' ? 'page' : undefined}
                data-testid={`app-switch-${it.key}`}
              >
                {body}
              </a>
            );
          })}
          <div className="ar-switch__foot">Each app checks your access again when it opens.</div>
        </div>
      ) : null}
    </div>
  );
}
