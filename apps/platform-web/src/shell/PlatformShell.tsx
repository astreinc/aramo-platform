import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AppShell,
  Breadcrumb,
  Icons,
  Rail,
  RailNavItem,
  RailNavLabel,
  ShellBrand,
  TopBar,
  UserMenu,
  logout,
  type BreadcrumbItem,
} from '@aramo/fe-foundation';

import './platform-shell.css';

// The platform console chrome. Reuses the extracted fe-foundation AppShell kit
// (rail + topbar + user menu) — zero locally-defined chrome. The PLATFORM marker
// (A3 anti-footgun) makes the god-console unmistakable: the violet rail + a
// PLATFORM pill in the topbar. No /me enrichment (platform-web has no /v1 proxy
// to reach GET /v1/me), so UserMenu renders loading-safe — Sign out is always
// available; the identity panel is intentionally minimal.

function crumbsFor(pathname: string): BreadcrumbItem[] {
  // Inc-3 PR-3.8 — the dashboard is the home crumb; tenant routes hang off it.
  if (pathname === '/' || pathname === '') {
    return [{ label: 'Dashboard' }];
  }
  const crumbs: BreadcrumbItem[] = [
    { label: 'Dashboard', href: '/' },
    { label: 'Tenants', href: '/tenants' },
  ];
  const m = /^\/tenants\/([^/]+)/.exec(pathname);
  if (pathname.startsWith('/tenants/new')) {
    crumbs.push({ label: 'Provision' });
  } else if (m) {
    crumbs.push({ label: 'Detail' });
  }
  return crumbs;
}

export function PlatformShell({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const handleSignOut = (): void => {
    void logout();
  };

  const rail = (
    <Rail>
      <span className="pw-platform-mark" aria-label="Platform console">
        PLATFORM
      </span>
      <RailNavLabel>Operations</RailNavLabel>
      <RailNavItem to="/" end label="Dashboard" icon={<Icons.IconDesk />} />
      <RailNavItem
        to="/tenants"
        label="Tenants"
        icon={<Icons.IconBuilding />}
      />
    </Rail>
  );

  const topBar = (
    <TopBar>
      <ShellBrand brand="Aramo" brandSub="Platform Console" to="/" />
      <span className="pw-topbar-mark" aria-hidden="true">
        PLATFORM
      </span>
      <Breadcrumb items={crumbsFor(pathname)} />
      <div className="pw-topbar-spacer" />
      <UserMenu name="" email="" roleLine={null} onSignOut={handleSignOut} />
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      {children}
    </AppShell>
  );
}
