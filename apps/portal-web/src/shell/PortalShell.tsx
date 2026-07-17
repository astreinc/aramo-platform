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

import './portal-shell.css';

// Portal P1 PR-3 — the portal chrome. Reuses the extracted fe-foundation AppShell
// kit (rail + topbar + user menu) — zero locally-defined chrome. The teal rail +
// a PORTAL marker make it unmistakably the talent's own surface (not a
// recruiter/operator console). No trust UI, no consent-write UI (P2+).
function crumbsFor(pathname: string): BreadcrumbItem[] {
  if (pathname === '/' || pathname === '') {
    return [{ label: 'Your records' }];
  }
  if (/^\/verifications/.test(pathname)) {
    return [{ label: 'Verified identity' }];
  }
  if (/^\/disputes\/[^/]+/.test(pathname)) {
    return [{ label: 'Disputes', href: '/disputes' }, { label: 'Dispute' }];
  }
  if (/^\/disputes/.test(pathname)) {
    return [{ label: 'Disputes' }];
  }
  if (/^\/notice/.test(pathname)) {
    return [{ label: 'Notice' }];
  }
  if (/^\/rights/.test(pathname)) {
    return [{ label: 'Delete my identity' }];
  }
  const crumbs: BreadcrumbItem[] = [{ label: 'Your records', href: '/' }];
  if (/^\/records\/[^/]+/.test(pathname)) {
    crumbs.push({ label: 'Record' });
  }
  return crumbs;
}

export function PortalShell({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const handleSignOut = (): void => {
    void logout();
  };

  const rail = (
    <Rail>
      <span className="po-portal-mark" aria-label="Talent portal">
        PORTAL
      </span>
      <RailNavLabel>You</RailNavLabel>
      <RailNavItem to="/" end label="Your records" icon={<Icons.IconBuilding />} />
      <RailNavItem
        to="/verifications"
        label="Verified identity"
        icon={<Icons.IconShieldCheck />}
      />
      <RailNavItem to="/disputes" label="Disputes" icon={<Icons.IconMessage />} />
      <RailNavItem to="/notice" label="Notice" icon={<Icons.IconInfo />} />
      <RailNavItem to="/rights" label="Delete my identity" icon={<Icons.IconBan />} />
    </Rail>
  );

  const topBar = (
    <TopBar>
      <ShellBrand brand="Aramo" brandSub="Portal" to="/" />
      <span className="po-topbar-mark" aria-hidden="true">
        PORTAL
      </span>
      <Breadcrumb items={crumbsFor(pathname)} />
      <div className="po-topbar-spacer" />
      <UserMenu name="" email="" roleLine={null} onSignOut={handleSignOut} />
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      {children}
    </AppShell>
  );
}
