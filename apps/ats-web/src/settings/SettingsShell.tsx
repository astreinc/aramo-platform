import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import {
  IconBranch,
  IconBrowser,
  IconBuilding,
  IconCard,
  IconForm,
  IconGlobe,
  IconHistory,
  IconLock,
  IconMail,
  IconShield,
  IconShieldCheck,
  IconSliders,
  IconUpload,
  IconUsers,
} from '../ui/icons';

// Settings Rebuild Directive 1 — the settings shell.
//
// The six-group inner rail (the consolidation pattern): every section is a
// nested route under one settings shell, rendered through <Outlet/>. The rail
// is the mockup's grouped left nav reconciled to Confident Blue.
//
// SCOPE: the whole subtree already sits behind <AdminGate> (the tenant:admin:*
// family gate, server-enforced) — the rail items are NOT individually scope-
// gated; the section gate covers them. UI hide is UX; the API is the boundary.
//
// Section status (the no-dead-knobs map):
//   • live    — fully wired to a real backend (Users, Branches&teams,
//               Tenant-profile Defaults, Import, Data&compliance Export).
//   • soon    — an honest seam; a clearly-marked placeholder. The build-later
//               ones (Tenant-profile, Roles, Audit) get real PRs next.
//   • soon (forbidden) — Career portal + Apply flow: refusal-layer forbidden;
//               seams by mandate, never wired.
// The rail surfaces the status as a small badge so the surface reads honestly
// before a section is even opened; the section content marks it again.

type Status = 'live' | 'soon';

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Destination path (under /admin). */
  readonly to: string;
  /** Pathname fragment used to compute the active state. */
  readonly match: string;
  readonly status: Status;
  /** Rail badge ("New" for the freshly-live Import; "Soon" for seams). */
  readonly badge?: { readonly text: string; readonly soon: boolean };
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const SOON = { text: 'Soon', soon: true } as const;

export const SETTINGS_NAV: readonly NavGroup[] = [
  {
    heading: 'Workspace',
    items: [
      {
        key: 'profile',
        label: 'Tenant profile',
        icon: <IconBuilding />,
        to: '/admin/settings/profile',
        match: '/admin/settings/profile',
        status: 'live',
      },
      {
        key: 'branches',
        label: 'Branches & teams',
        icon: <IconBranch />,
        to: '/admin/settings/branches',
        match: '/admin/settings/branches',
        status: 'live',
      },
      {
        key: 'localization',
        label: 'Localization',
        icon: <IconGlobe />,
        to: '/admin/settings/localization',
        match: '/admin/settings/localization',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
  {
    heading: 'People & access',
    items: [
      {
        key: 'users',
        label: 'Users',
        icon: <IconUsers />,
        to: '/admin/users',
        match: '/admin/users',
        status: 'live',
      },
      {
        key: 'roles',
        label: 'Roles & permissions',
        icon: <IconShieldCheck />,
        to: '/admin/settings/roles',
        match: '/admin/settings/roles',
        status: 'soon',
        badge: SOON,
      },
      {
        key: 'security',
        label: 'Security & SSO',
        icon: <IconLock />,
        to: '/admin/settings/security',
        match: '/admin/settings/security',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
  {
    heading: 'Talent experience',
    items: [
      {
        key: 'portal',
        label: 'Career portal',
        icon: <IconBrowser />,
        to: '/admin/settings/portal',
        match: '/admin/settings/portal',
        status: 'soon',
        badge: SOON,
      },
      {
        key: 'apply',
        label: 'Apply flow',
        icon: <IconForm />,
        to: '/admin/settings/apply',
        match: '/admin/settings/apply',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
  {
    heading: 'Communication',
    items: [
      {
        key: 'email',
        label: 'Email & notifications',
        icon: <IconMail />,
        to: '/admin/settings/email',
        match: '/admin/settings/email',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
  {
    heading: 'Data',
    items: [
      {
        key: 'import',
        label: 'Import data',
        icon: <IconUpload />,
        to: '/admin/settings/import',
        match: '/admin/settings/import',
        status: 'live',
        badge: { text: 'New', soon: false },
      },
      {
        key: 'compliance',
        label: 'Data & compliance',
        icon: <IconShieldCheck />,
        to: '/admin/settings/compliance',
        match: '/admin/settings/compliance',
        status: 'live',
      },
      {
        key: 'fields',
        label: 'Custom fields',
        icon: <IconSliders />,
        to: '/admin/settings/fields',
        match: '/admin/settings/fields',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
  {
    heading: 'Account',
    items: [
      {
        key: 'billing',
        label: 'Plan & billing',
        icon: <IconCard />,
        to: '/admin/settings/billing',
        match: '/admin/settings/billing',
        status: 'soon',
        badge: SOON,
      },
      {
        key: 'audit',
        label: 'Audit log',
        icon: <IconHistory />,
        to: '/admin/settings/audit',
        match: '/admin/settings/audit',
        status: 'soon',
        badge: SOON,
      },
    ],
  },
];

// The residual admin-tools affordance (Lead ruling C): consent + the per-record
// assignment editors are NOT settings sections, but must stay reachable. A
// single rail link keeps them discoverable from anywhere in /admin.
const TOOLS_ITEM: NavItem = {
  key: 'tools',
  label: 'Admin tools',
  icon: <IconShield />,
  to: '/admin/tools',
  match: '/admin/tools',
  status: 'live',
};

function isActive(pathname: string, item: NavItem): boolean {
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={`set-navbtn${active ? ' on' : ''}`}
      aria-current={active ? 'page' : undefined}
      data-testid={`settings-nav-${item.key}`}
    >
      {item.icon}
      <span>{item.label}</span>
      {item.badge != null ? (
        <span
          className={`set-navbtn__badge${item.badge.soon ? ' set-navbtn__badge--soon' : ''}`}
        >
          {item.badge.text}
        </span>
      ) : null}
    </Link>
  );
}

export function SettingsShell() {
  const { pathname } = useLocation();
  return (
    <div className="set-shell">
      <nav className="set-subnav" aria-label="Settings sections">
        {SETTINGS_NAV.map((group) => (
          <div key={group.heading}>
            <div className="set-sgrp">{group.heading}</div>
            {group.items.map((item) => (
              <RailLink
                key={item.key}
                item={item}
                active={isActive(pathname, item)}
              />
            ))}
          </div>
        ))}
        <div className="set-sgrp">Tools</div>
        <RailLink item={TOOLS_ITEM} active={isActive(pathname, TOOLS_ITEM)} />
      </nav>
      <div className="set-shell__main">
        <Outlet />
      </div>
    </div>
  );
}
