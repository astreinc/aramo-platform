import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  AppSwitcher,
  AramoAppShell,
  AramoRail,
  IconSliders,
  IconColumns,
  TopBar,
  UserMenu,
  buildAppSwitcherItems,
  initialsOf,
  logout,
  type AramoRailSection,
  type ProductAvailabilityView,
} from '@aramo/fe-foundation';
import {
  ORGANIZATION_HEADING,
  SHARED_SETUP_HEADING,
  orgSectionForPath,
  orgSectionsFor,
  useMe,
  useOrgAccess,
  type OrgAccessTier,
  type OrgSection,
} from '@aramo/org-admin-web';

// The App Home + Organization chrome — the SAME shared Aramo shell as the ATS
// (AramoAppShell + AramoRail, one collapse preference). ORG-UX-1 (Directive v1.0
// LOCKED §1, §4.3, §7.1; App Home & Organization handoff rev. Oct 21 §2):
//   rail     PLATFORM · App Home
//            ORGANIZATION (org admins)  Overview · Profile · Users & invitations ·
//                                       Roles & access · Sites · Domain
//            SHARED SETUP (org admins)  Settings · Our templates · Template gallery · Audit
//            — a template author (org_access "templates") sees PLATFORM + SHARED SETUP
//              with Our templates + Template gallery only; "none" sees App Home only.
//   top bar  breadcrumb (Organization / {Section}) · app switcher · organization
//            name · account menu
// Who sees what is the SERVER's org_access projection (GET /v1/me/products) — never
// derived from session scopes. Navigation only: every Organization API keeps its own
// server-side guard.

const ICON_HOME = 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z';

interface HomeShellProps {
  readonly children: ReactNode;
  /** Test seam — replaces the GET /v1/me/products read. */
  readonly fetchProducts?: () => Promise<ProductAvailabilityView>;
}

function railItem(s: OrgSection) {
  return { key: s.key, to: s.path, label: s.label, iconPath: s.iconPath, gear: s.gear, testId: `org-nav-${s.key}` };
}

/** The rail sections for an Organization access tier (handoff §2 table). */
export function homeRailSections(access: OrgAccessTier): AramoRailSection[] {
  const sections = orgSectionsFor(access);
  return [
    { label: 'Platform', kind: 'primary', items: [{ key: 'home', to: '/', label: 'App Home', iconPath: ICON_HOME, testId: 'home-nav-home' }] },
    { label: ORGANIZATION_HEADING, kind: 'work', items: sections.filter((s) => s.group === 'organization').map(railItem) },
    { label: SHARED_SETUP_HEADING, kind: 'work', items: sections.filter((s) => s.group === 'shared').map(railItem) },
  ];
}

function Crumb({ pathname, access }: { readonly pathname: string; readonly access: OrgAccessTier }) {
  if (pathname === '/org' || pathname.startsWith('/org/')) {
    const section = orgSectionForPath(pathname);
    return (
      <nav aria-label="Breadcrumb" className="home-crumb" data-testid="home-crumb">
        {access === 'admin' ? (
          <Link to="/org/overview" className="home-crumb__root">
            Organization
          </Link>
        ) : (
          <span className="home-crumb__root">Organization</span>
        )}
        {section !== null ? (
          <>
            <span className="home-crumb__sep" aria-hidden="true">
              {' / '}
            </span>
            <span aria-current="page">{section.label}</span>
          </>
        ) : null}
      </nav>
    );
  }
  return (
    <span className="home-crumb" data-testid="home-crumb">
      {pathname.startsWith('/preferences') ? 'My preferences' : 'App Home'}
    </span>
  );
}

export function HomeShell({ children, fetchProducts }: HomeShellProps) {
  const me = useMe();
  const orgAccess = useOrgAccess(fetchProducts);
  const { pathname } = useLocation();
  const [switcherSignal, setSwitcherSignal] = useState(0);
  // While the availability read is loading (or failed) the rail shows App Home only.
  const access: OrgAccessTier = orgAccess.status === 'ready' ? orgAccess.access : 'none';
  const products = orgAccess.status === 'ready' ? orgAccess.products : null;
  const displayName = me?.user.display_name ?? me?.user.email ?? '';
  const tenantName = me?.tenant.display_name ?? null;
  const inOrg = pathname === '/org' || pathname.startsWith('/org/');
  const activeKey = pathname === '/' ? 'home' : inOrg ? (orgSectionForPath(pathname)?.key ?? null) : null;

  const rail = (
    <AramoRail
      sections={homeRailSections(access)}
      activeKey={activeKey}
      userInitials={initialsOf(displayName || '?')}
      userName={displayName}
      tenantName={tenantName}
      homeTo="/"
      homeLabel="App Home"
    />
  );

  const topBar = (
    <TopBar>
      <Crumb pathname={pathname} access={access} />
      <AppSwitcher
        organizationName={tenantName}
        items={buildAppSwitcherItems({ current: inOrg ? 'org' : 'home', products })}
        openSignal={switcherSignal}
      />
      {tenantName !== null ? (
        <span className="home-orgname" title={tenantName}>
          {tenantName}
        </span>
      ) : null}
      <UserMenu
        name={displayName}
        email={me?.user.email ?? ''}
        roleLine={null}
        roleBadge={access === 'admin' ? 'ADMIN' : 'MEMBER'}
        onSignOut={() => void logout()}
        items={[
          { key: 'prefs', label: 'My preferences', sub: 'Start page · App Home', icon: <IconSliders />, to: '/preferences' },
          { key: 'switch', label: 'Switch application', icon: <IconColumns />, onSelect: () => setSwitcherSignal((n) => n + 1) },
        ]}
      />
    </TopBar>
  );

  return (
    <AramoAppShell rail={rail} topBar={topBar}>
      {children}
    </AramoAppShell>
  );
}
