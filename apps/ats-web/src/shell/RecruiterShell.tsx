import {
  apiClient,
  hasScope,
  LOGIN_PATH,
  LOGOUT_PATH,
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

// RecruiterShell — Phase 2A. The app-layer chrome that REPLACES the frozen
// fe-foundation Shell (non-consumption, Lead-approved). Composes AppShell +
// Rail + TopBar: scope-gated nav rendered as real react-router NavLinks (the
// keyboard/SR navigation path), a route-derived breadcrumb, the visual ⌘K
// entry + notifications bell, and the LOGOUT control (preserved from the frozen
// Shell — same POST /logout best-effort → redirect-to-login contract).
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
const ADMIN_NAV: readonly NavItem[] = [
  { to: '/admin', end: true, label: 'Admin', icon: <IconShield /> },
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
  admin: 'Administration',
};

function HUMAN_CONSUMER(type: Session['consumer_type']): string {
  switch (type) {
    case 'recruiter':
      return 'Recruiter';
    case 'portal':
      return 'Portal user';
    case 'ingestion':
      return 'Ingestion';
    default:
      return 'User';
  }
}

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
  const segment = location.pathname.split('/')[1] ?? '';
  const entity = useBreadcrumbEntity();
  const section = SECTION_LABEL[segment] ?? 'Aramo';
  const crumbs: readonly BreadcrumbItem[] =
    entity !== null
      ? [{ label: section, href: `/${segment}` }, { label: entity }]
      : [{ label: section }];

  const handleLogout = async () => {
    try {
      await apiClient.post(LOGOUT_PATH);
    } catch {
      // Same outcome on success/failure; never surface internals (R10/R12).
    }
    (onLogoutComplete ?? (() => window.location.assign(LOGIN_PATH)))();
  };

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

  const role = HUMAN_CONSUMER(session.consumer_type);

  const rail = (
    <Rail
      user={
        <>
          <RailUser initials={role.charAt(0)} name={role} />
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
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      {children}
    </AppShell>
  );
}
