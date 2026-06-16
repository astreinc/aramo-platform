import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, NavLink as RouterNavLink } from 'react-router-dom';

import {
  IconChevronLeft,
  IconChevronRight,
  IconLogo,
  IconSearch,
} from './icons';

const RAIL_COLLAPSE_KEY = 'rc-rail-collapsed';

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
  // Collapsible rail (user toggle). Collapsed → a ~64px icon strip so the main
  // content reclaims the width; the choice persists across reloads. The shell
  // brand lives in the TopBar (see <ShellBrand>) so it stays visible in both
  // states. A separate responsive auto-collapse (<=1080px) is CSS-only.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // private mode / no storage — the toggle still works for the session.
    }
  }, [collapsed]);

  return (
    <div className={`rc-app${collapsed ? ' rc-app--rail-collapsed' : ''}`}>
      {rail}
      <button
        type="button"
        className="rc-rail-toggle"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
      </button>
      <div className="rc-main">
        {topBar}
        <div className="rc-content">{children}</div>
      </div>
    </div>
  );
}

// ─── ShellBrand (the Aramo logo, now hosted in the TopBar) ───

interface ShellBrandProps {
  readonly brand?: string;
  readonly brandSub?: string;
  /** Home target (the brand is a link). */
  readonly to?: string;
}

export function ShellBrand({
  brand = 'Aramo',
  brandSub = 'Talent Intelligence',
  to = '/',
}: ShellBrandProps) {
  return (
    <RouterLink to={to} className="rc-topbar__brand" aria-label={`${brand} — home`}>
      <span className="rc-topbar__mark" aria-hidden="true">
        <IconLogo />
      </span>
      <span className="rc-topbar__name">
        {brand}
        <small>{brandSub}</small>
      </span>
    </RouterLink>
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
  brand,
  brandSub = 'Talent Intelligence',
  children,
  user,
}: RailProps) {
  return (
    <aside className="rc-rail">
      {/* Brand is OPTIONAL here — the recruiter shell hosts it in the TopBar
          (<ShellBrand>) so it survives a rail collapse. Still rendered when a
          consumer (e.g. the UI gallery) passes `brand`. */}
      {brand !== undefined ? (
        <div className="rc-rail__brand">
          <div className="rc-rail__mark" aria-hidden="true">
            <IconLogo />
          </div>
          <div className="rc-rail__name">
            {brand}
            <small>{brandSub}</small>
          </div>
        </div>
      ) : null}
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
      <RouterNavLink to={to} end={end} className="rc-nav__item" title={label}>
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
        title={label}
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
      title={label}
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
              <RouterLink to={it.href}>{it.label}</RouterLink>
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
