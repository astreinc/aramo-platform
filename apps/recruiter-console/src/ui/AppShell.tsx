import type { ReactNode } from 'react';
import { NavLink as RouterNavLink } from 'react-router-dom';

import { IconChevronRight, IconLogo, IconSearch } from './icons';

// ─────────────────────────────────────────────────────────────────────────
// AppShell — the new app-layer chrome (Lead-approved NON-CONSUMPTION of the
// frozen fe-foundation Shell, which cannot express the mockup rail/topbar:
// nav icons, count badges, section labels, a rail user-footer, a breadcrumb,
// a ⌘K search field, or a notifications bell). Built above the freeze; the
// lib is untouched. App-scoped now, promotable to a lib later.
// ─────────────────────────────────────────────────────────────────────────

interface AppShellProps {
  /** The left rail (compose with <Rail>). */
  readonly rail: ReactNode;
  /** The sticky top bar (compose with <TopBar>). */
  readonly topBar?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({ rail, topBar, children }: AppShellProps) {
  return (
    <div className="rc-app">
      {rail}
      <div className="rc-main">
        {topBar}
        <div className="rc-content">{children}</div>
      </div>
    </div>
  );
}

// ─── Rail ───

interface RailProps {
  readonly brand?: string;
  readonly brandSub?: string;
  /** Nav items + section labels (compose with <RailNavItem>/<RailNavLabel>). */
  readonly children: ReactNode;
  /** The footer user (compose with <RailUser>). */
  readonly user?: ReactNode;
}

export function Rail({
  brand = 'Aramo',
  brandSub = 'Talent Intelligence',
  children,
  user,
}: RailProps) {
  return (
    <aside className="rc-rail">
      <div className="rc-rail__brand">
        <div className="rc-rail__mark" aria-hidden="true">
          <IconLogo />
        </div>
        <div className="rc-rail__name">
          {brand}
          <small>{brandSub}</small>
        </div>
      </div>
      <nav className="rc-nav" aria-label="Primary">
        {children}
      </nav>
      {user != null ? <div className="rc-rail__foot">{user}</div> : null}
    </aside>
  );
}

interface RailNavItemProps {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly count?: number;
  /** React-router target. When set, renders a real <NavLink> (the a11y path). */
  readonly to?: string;
  /** Match `to` exactly (use for the index/"My desk" link). */
  readonly end?: boolean;
  /** Static-active override for non-router usage (e.g. the gallery). */
  readonly active?: boolean;
  readonly onActivate?: () => void;
  readonly href?: string;
}

// A single rail entry. Preferred form passes `to` → a react-router <NavLink>
// (a real focusable anchor; aria-current="page" is set automatically when
// active, which the rc CSS keys on). The `active`/`href`/`onActivate` forms
// remain for non-router/static usage (the gallery).
export function RailNavItem({
  icon,
  label,
  count,
  to,
  end,
  active = false,
  onActivate,
  href,
}: RailNavItemProps) {
  const inner = (
    <>
      {icon}
      <span>{label}</span>
      {count != null ? <span className="rc-nav__count num">{count}</span> : null}
    </>
  );
  if (to != null) {
    return (
      <RouterNavLink to={to} end={end} className="rc-nav__item">
        {inner}
      </RouterNavLink>
    );
  }
  const aria = active ? ('page' as const) : undefined;
  if (href != null) {
    return (
      <a
        className="rc-nav__item"
        href={href}
        aria-current={aria}
        onClick={onActivate}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="rc-nav__item"
      aria-current={aria}
      onClick={onActivate}
    >
      {inner}
    </button>
  );
}

export function RailNavLabel({ children }: { readonly children: ReactNode }) {
  return <div className="rc-nav__label">{children}</div>;
}

interface RailUserProps {
  readonly initials: string;
  readonly name: string;
  readonly role?: string;
}

export function RailUser({ initials, name, role }: RailUserProps) {
  return (
    <div className="rc-rail__user">
      <div className="rc-rail__user-av" aria-hidden="true">
        {initials}
      </div>
      <div className="rc-rail__who">
        {name}
        {role != null ? <small>{role}</small> : null}
      </div>
    </div>
  );
}

// ─── TopBar ───

interface TopBarProps {
  readonly children: ReactNode;
}

export function TopBar({ children }: TopBarProps) {
  return <header className="rc-topbar">{children}</header>;
}

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

interface BreadcrumbProps {
  readonly items: readonly BreadcrumbItem[];
}

// Trail of crumbs; the last is the current page (bold, no link). Uses an
// aria-label="Breadcrumb" nav with a separator between entries.
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="rc-crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${it.label}-${i}`} style={{ display: 'contents' }}>
            {i > 0 ? <IconChevronRight /> : null}
            {last || it.href == null ? (
              <span className="rc-crumbs__here" aria-current={last ? 'page' : undefined}>
                {it.label}
              </span>
            ) : (
              <a href={it.href}>{it.label}</a>
            )}
          </span>
        );
      })}
    </nav>
  );
}

interface CmdKSearchProps {
  readonly placeholder?: string;
  readonly onActivate?: () => void;
}

// Visual command-palette entry (⌘K). Phase 1 is a visual affordance only —
// the palette itself is an explicit follow-up. role="button" + keyboard
// activation keep it accessible.
export function CmdKSearch({
  placeholder = 'Search requisitions, talent…',
  onActivate,
}: CmdKSearchProps) {
  return (
    <div
      className="rc-cmdk"
      role="button"
      tabIndex={0}
      aria-label={placeholder}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate?.();
        }
      }}
    >
      <IconSearch />
      <span>{placeholder}</span>
      <kbd>⌘K</kbd>
    </div>
  );
}

interface NotificationButtonProps {
  readonly hasUnread?: boolean;
  readonly onClick?: () => void;
}

export function NotificationButton({ hasUnread = false, onClick }: NotificationButtonProps) {
  return (
    <button
      type="button"
      className="rc-iconbtn"
      aria-label={hasUnread ? 'Notifications (unread)' : 'Notifications'}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {hasUnread ? <span className="rc-iconbtn__dot" /> : null}
    </button>
  );
}
