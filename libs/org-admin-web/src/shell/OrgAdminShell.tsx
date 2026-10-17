import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  IconBranch,
  IconBuilding,
  IconCard,
  IconGlobe,
  IconDesk,
  IconHistory,
  IconLock,
  IconShieldCheck,
  IconUsers,
} from '@aramo/fe-foundation';

// D-ORG-3 — the Organization Administration shell (§3.E).
//
// The product-neutral administration surface on the App Home (apps/home-web,
// /org/*): the same six-group inner-rail grammar as the ATS settings shell
// (fe-foundation settings.css), hosting what the ORGANIZATION owns — profile,
// sites, domain, the user directory + invitations + roles, shared settings
// seams, and the audit log. Product-specific settings stay in each product
// (ATS recruiting/import/compliance/integrations… under /ats/admin).
//
// SCOPE: the whole subtree sits behind OrgAdminRoutes' `tenant:admin:*` gate
// (server-enforced per route); rail items are not individually scope-gated.

type Status = 'live' | 'soon';

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly to: string;
  readonly match: string;
  readonly status: Status;
  readonly badge?: { readonly text: string; readonly soon: boolean };
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const SOON = { text: 'Soon', soon: true } as const;

export const ORG_NAV: readonly NavGroup[] = [
  {
    heading: 'Organization',
    items: [
      { key: 'profile', label: 'Organization profile', icon: <IconBuilding />, to: '/org/profile', match: '/org/profile', status: 'live' },
      { key: 'sites', label: 'Sites & branches', icon: <IconBranch />, to: '/org/sites', match: '/org/sites', status: 'live' },
      { key: 'domain', label: 'Domain verification', icon: <IconShieldCheck />, to: '/org/domain', match: '/org/domain', status: 'live' },
      { key: 'localization', label: 'Localization', icon: <IconGlobe />, to: '/org/localization', match: '/org/localization', status: 'soon', badge: SOON },
    ],
  },
  {
    heading: 'People & access',
    items: [
      { key: 'users', label: 'Users', icon: <IconUsers />, to: '/org/users', match: '/org/users', status: 'live' },
      { key: 'roles', label: 'Roles & permissions', icon: <IconShieldCheck />, to: '/org/roles', match: '/org/roles', status: 'live' },
      { key: 'security', label: 'Security & SSO', icon: <IconLock />, to: '/org/security', match: '/org/security', status: 'soon', badge: SOON },
    ],
  },
  {
    heading: 'Account',
    items: [
      { key: 'billing', label: 'Plan & billing', icon: <IconCard />, to: '/org/billing', match: '/org/billing', status: 'soon', badge: SOON },
      { key: 'audit', label: 'Audit log', icon: <IconHistory />, to: '/org/audit', match: '/org/audit', status: 'live' },
    ],
  },
];

// Back to the App Home (the product tiles) — always reachable from the rail.
const HOME_ITEM: NavItem = { key: 'home', label: 'App Home', icon: <IconDesk />, to: '/', match: '/', status: 'live' };

function isActive(pathname: string, item: NavItem): boolean {
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={`set-navbtn${active ? ' on' : ''}`}
      aria-current={active ? 'page' : undefined}
      data-testid={`org-nav-${item.key}`}
    >
      {item.icon}
      <span>{item.label}</span>
      {item.badge != null ? (
        <span className={`set-navbtn__badge${item.badge.soon ? ' set-navbtn__badge--soon' : ''}`}>
          {item.badge.text}
        </span>
      ) : null}
    </Link>
  );
}

export function OrgAdminShell() {
  const { pathname } = useLocation();
  return (
    <div className="set-shell">
      <nav className="set-subnav" aria-label="Organization sections">
        {ORG_NAV.map((group) => (
          <div key={group.heading}>
            <div className="set-sgrp">{group.heading}</div>
            {group.items.map((item) => (
              <RailLink key={item.key} item={item} active={isActive(pathname, item)} />
            ))}
          </div>
        ))}
        <div className="set-sgrp">Products</div>
        <RailLink item={HOME_ITEM} active={false} />
      </nav>
      <div className="set-shell__main">
        <Outlet />
      </div>
    </div>
  );
}
