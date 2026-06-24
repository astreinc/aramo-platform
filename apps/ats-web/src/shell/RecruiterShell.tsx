import {
  hasScope,
  logout,
  type Session,
} from '@aramo/fe-foundation';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { hasAdminScope } from '../admin/admin-access';
import {
  AppShell,
  ShellBrand,
  Breadcrumb,
  CmdKSearch,
  NotificationButton,
  Rail,
  RailNavItem,
  RailNavLabel,
  RailUser,
  TopBar,
  UserMenu,
  initialsOf,
  type BreadcrumbItem,
} from '../ui';
import {
  IconCompanies,
  IconContacts,
  IconDesk,
  IconLogout,
  IconRequisitions,
  IconSearch,
  IconShield,
  IconTalent,
  IconTasks,
} from '../ui/icons';

import { BreadcrumbProvider, useBreadcrumbEntity } from './breadcrumb';
import { useMe } from './me-api';

// The tenant-profile route — the existing destination for the user menu's
// Settings link (also the /admin default redirect target). Gated behind admin
// access (it lives under the tenant:admin:* admin surface), so the link is
// shown only to a principal who can reach it.
const SETTINGS_PROFILE_PATH = '/admin/settings/profile';

// RecruiterShell — Phase 2A. The app-layer chrome that REPLACES the frozen
// fe-foundation Shell (non-consumption, Lead-approved). Composes AppShell +
// Rail + TopBar: scope-gated nav rendered as real react-router NavLinks (the
// keyboard/SR navigation path), a route-derived breadcrumb, the visual ⌘K
// entry + notifications bell, and the LOGOUT control (the shared session
// logout — §5 D3: POST /logout local clear, then navigate to the Cognito
// hosted-UI /logout for SSO session termination; best-effort, same outcome
// on success/failure).
//
// Nav reconciled to canonical vocab (F2) and to routes that actually exist.
// "Contacts" now has a full list/detail surface (Contacts page) and is wired.
// "Activity" from the mockup still has no standalone route → carried.

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly end?: boolean;
  /** Scope-gate; omitted = always visible (the view gates internally). */
  readonly scope?: string;
}

const PRIMARY_NAV: readonly NavItem[] = [
  { to: '/', end: true, label: 'My desk', icon: <IconDesk />, scope: 'dashboard:read' },
  { to: '/requisitions', label: 'Requisitions', icon: <IconRequisitions />, scope: 'requisition:read' },
  { to: '/talent', label: 'Talent', icon: <IconTalent />, scope: 'talent:read' },
  { to: '/companies', label: 'Companies', icon: <IconCompanies />, scope: 'company:read' },
  { to: '/contacts', label: 'Contacts', icon: <IconContacts />, scope: 'contact:read' },
  // Search is always-visible (any-of-4 search scopes; the view gates per
  // section) — mirrors the existing R-NAV ruling.
  { to: '/search', label: 'Search', icon: <IconSearch /> },
];

const WORK_NAV: readonly NavItem[] = [
  { to: '/tasks', label: 'Tasks', icon: <IconTasks />, scope: 'task:read' },
];

// Admin-gated nav (FE Consolidation Phase 1). The section is shown only to a
// principal holding a `tenant:admin:*` scope (hasAdminScope); the individual
// items here are NOT per-item scope-gated — the section's family gate covers
// them. Empty placeholder destination this PR (the real admin modules + their
// own nav entries port in Phase 2+).
// Settings Rebuild Directive 1 — the admin surface is now the enterprise
// Settings shell (the PO calls it the heart of the ATS). The single rail entry
// lands on /admin (which redirects into the settings rail); the section rail
// lives inside SettingsShell. `end` is dropped so the item stays highlighted
// across the /admin/* subtree.
const ADMIN_NAV: readonly NavItem[] = [
  { to: '/admin', label: 'Settings', icon: <IconShield /> },
];

// First-path-segment → section label, for the breadcrumb. Entity-level crumbs
// (e.g. "Requisitions › Senior Rust Engineer") need the detail view to publish
// its title — carried; 2A renders the section crumb.
const SECTION_LABEL: Record<string, string> = {
  '': 'My desk',
  requisitions: 'Requisitions',
  talent: 'Talent',
  companies: 'Companies',
  contacts: 'Contacts',
  engagements: 'Engagement',
  search: 'Search',
  tasks: 'Tasks',
  admin: 'Settings',
};

interface RecruiterShellProps {
  readonly session: Session;
  readonly children: ReactNode;
  /** Test seam — replaces the post-logout redirect. */
  readonly onLogoutComplete?: () => void;
}

// Provider wraps the shell so a routed detail view's useEntityCrumb() update
// flows up to the TopBar breadcrumb (2D ruling).
export function RecruiterShell(props: RecruiterShellProps) {
  return (
    <BreadcrumbProvider>
      <RecruiterShellInner {...props} />
    </BreadcrumbProvider>
  );
}

function RecruiterShellInner({
  session,
  children,
  onLogoutComplete,
}: RecruiterShellProps) {
  const location = useLocation();
  const me = useMe();
  const segment = location.pathname.split('/')[1] ?? '';
  const entity = useBreadcrumbEntity();
  const section = SECTION_LABEL[segment] ?? 'Aramo';

  // The resolved /me display data (loading-safe — `me` is null until the fetch
  // resolves and stays null on error). Name falls back display_name → email;
  // the role line joins ALL roles ("Tenant Admin · Recruiter"); both the menu
  // and the rail footer read from the SAME source (no more consumer_type label).
  const displayName = me ? me.user.display_name ?? me.user.email : null;
  const roleLine =
    me && me.roles.length > 0 ? me.roles.join(' · ') : null;
  // Rail footer: real identity once loaded; neutral placeholders while in
  // flight so the chrome (avatar slot + logout) never collapses.
  const railName = displayName ?? '—';
  const railInitials = displayName ? initialsOf(displayName) : '·';
  const crumbs: readonly BreadcrumbItem[] =
    entity !== null
      ? [{ label: section, href: `/${segment}` }, { label: entity }]
      : [{ label: section }];

  // §5 Auth-Hardening D3: the shared session logout — clears the LOCAL session
  // (POST /logout) then navigates to the Cognito hosted-UI /logout to terminate
  // the SSO session. Identical for the recruiter AND admin surfaces (both ride
  // this one shell + one session). Same outcome on success/failure; never
  // surface internals (R10/R12).
  const handleLogout = () => logout(onLogoutComplete);

  const renderNav = (items: readonly NavItem[]) =>
    items
      .filter((item) => item.scope === undefined || hasScope(session, item.scope))
      .map((item) => (
        <RailNavItem
          key={item.to}
          to={item.to}
          end={item.end}
          icon={item.icon}
          label={item.label}
        />
      ));

  const rail = (
    <Rail
      user={
        <>
          <RailUser
            initials={railInitials}
            name={railName}
            role={roleLine ?? undefined}
          />
          <button
            type="button"
            className="rc-rail__logout"
            onClick={handleLogout}
          >
            <IconLogout />
            <span>Log out</span>
          </button>
        </>
      }
    >
      {renderNav(PRIMARY_NAV)}
      <RailNavLabel>Work</RailNavLabel>
      {renderNav(WORK_NAV)}
      {hasAdminScope(session) ? (
        <>
          <RailNavLabel>Administration</RailNavLabel>
          {renderNav(ADMIN_NAV)}
        </>
      ) : null}
    </Rail>
  );

  const topBar = (
    <TopBar>
      <ShellBrand brand="Aramo" brandSub="Talent Intelligence" to="/" />
      <Breadcrumb items={crumbs} />
      <CmdKSearch />
      <NotificationButton />
      {/* Org-context label (M365 pattern) — the tenant display_name as plain
          text, NOT a logo. The internal brand stays pure-Aramo (ShellBrand);
          the tenant appears ONLY here. Hidden until /me resolves. */}
      {me ? (
        <span className="rc-orglabel" title={me.tenant.display_name}>
          {me.tenant.display_name}
        </span>
      ) : null}
      <UserMenu
        name={displayName ?? ''}
        email={me?.user.email ?? ''}
        roleLine={roleLine}
        onSignOut={handleLogout}
        settingsHref={
          hasAdminScope(session) ? SETTINGS_PROFILE_PATH : undefined
        }
      />
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      {children}
    </AppShell>
  );
}
