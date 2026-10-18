import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { Avatar } from './Avatar';
import { IconChevronDown, IconLogout, IconShield, IconSliders } from './icons';

// Aramo-Identity-Me-Endpoint-UserMenu-Directive-v1_0 — the top-right account
// menu (the M365 pattern). A net-new chrome atom (no frozen primitive expresses
// an avatar trigger + identity panel). It is PURELY presentational: the caller
// (RecruiterShell) feeds it the resolved /me display data and the existing
// sign-out action; the avatar is initials-only (reuses Avatar — no avatar_url).
//
// Loading-safe: every text field is optional. While /me is in flight the
// caller passes empty strings → the panel shows only the always-available
// "Sign out" (the avatar falls back to "?"), so the chrome never blocks on /me.
//
// Accessibility: the trigger is a real button (aria-haspopup="menu",
// aria-expanded); the panel is role="menu" with role="menuitem" entries; the
// menu closes on outside-click and Escape.

interface UserMenuProps {
  /** display_name || email. Empty while /me is in flight. */
  readonly name: string;
  /** The caller's email. Empty while /me is in flight. */
  readonly email: string;
  /** All roles joined (e.g. "Tenant Admin · Recruiter"); null when none. */
  readonly roleLine: string | null;
  /** The shared session sign-out (always available, independent of /me). */
  readonly onSignOut: () => void;
  /** Admin "Settings" (tenant/workspace admin) — present ONLY when the caller can reach it. */
  readonly settingsHref?: string;
  /** "My Settings" (personal, every user) — present for any signed-in user. */
  readonly mySettingsHref?: string;
  /** Unified shell: a short role badge under the email (e.g. ADMIN / MEMBER). */
  readonly roleBadge?: string;
  /**
   * Unified shell (App Home handoff §3): the account rows, rendered in order
   * before Sign out. When supplied, they replace the legacy Settings / My
   * Settings rows.
   */
  readonly items?: readonly UserMenuItem[];
}

export interface UserMenuItem {
  readonly key: string;
  readonly label: string;
  readonly sub?: string;
  readonly icon: ReactNode;
  /** Router path in the current SPA. */
  readonly to?: string;
  /** Full-navigation href (another SPA on this host). */
  readonly href?: string;
  readonly onSelect?: () => void;
}

export function UserMenu({
  name,
  email,
  roleLine,
  onSignOut,
  settingsHref,
  mySettingsHref,
  roleBadge,
  items,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div className="rc-usermenu" ref={ref}>
      <button
        type="button"
        className="rc-usermenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name ? `Account: ${name}` : 'Account menu'}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={name || email || undefined} size="sm" />
        <IconChevronDown />
      </button>
      {open ? (
        <div className="rc-usermenu__panel" role="menu">
          {name || email || roleLine ? (
            <div className="rc-usermenu__id">
              {name ? <div className="rc-usermenu__name">{name}</div> : null}
              {email ? <div className="rc-usermenu__email">{email}</div> : null}
              {roleLine ? (
                <div className="rc-usermenu__role">{roleLine}</div>
              ) : null}
              {roleBadge ? <span className="rc-usermenu__badge">{roleBadge}</span> : null}
            </div>
          ) : null}
          {items !== undefined
            ? items.map((it) => {
                const inner = (
                  <>
                    {it.icon}
                    <span className="rc-usermenu__itemtext">
                      <span>{it.label}</span>
                      {it.sub ? <span className="rc-usermenu__itemsub">{it.sub}</span> : null}
                    </span>
                  </>
                );
                if (it.to !== undefined) {
                  return (
                    <RouterLink key={it.key} to={it.to} role="menuitem" className="rc-usermenu__item" onClick={() => setOpen(false)}>
                      {inner}
                    </RouterLink>
                  );
                }
                if (it.href !== undefined) {
                  return (
                    <a key={it.key} href={it.href} role="menuitem" className="rc-usermenu__item">
                      {inner}
                    </a>
                  );
                }
                return (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    className="rc-usermenu__item"
                    onClick={() => {
                      setOpen(false);
                      it.onSelect?.();
                    }}
                  >
                    {inner}
                  </button>
                );
              })
            : null}
          {items === undefined && settingsHref ? (
            <RouterLink
              to={settingsHref}
              role="menuitem"
              className="rc-usermenu__item"
              onClick={() => setOpen(false)}
            >
              <IconShield />
              <span>Settings</span>
            </RouterLink>
          ) : null}
          {items === undefined && mySettingsHref ? (
            <RouterLink
              to={mySettingsHref}
              role="menuitem"
              className="rc-usermenu__item"
              onClick={() => setOpen(false)}
            >
              <IconSliders />
              <span>My Settings</span>
            </RouterLink>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`rc-usermenu__item${items !== undefined ? ' rc-usermenu__item--signout' : ''}`}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <IconLogout />
            <span>Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
