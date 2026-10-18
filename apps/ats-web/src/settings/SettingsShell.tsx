import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  IconBranch,
  IconBrowser,
  IconBuilding,
  IconFile,
  IconForm,
  IconMail,
  IconPlug,
  IconShield,
  IconShieldCheck,
  IconSliders,
  IconUpload,
} from '@aramo/fe-foundation';

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
// D-ORG-3 (Organization Administration carve): this rail now holds ONLY what
// the ATS product owns (teams, talent experience, email templates, recruiting,
// document templates, import/compliance/custom fields, integrations). The
// organization-owned sections (profile, sites, domain, users, roles, security,
// billing, audit) moved to the App Home at /org/* (libs/org-admin-web) and the
// first rail group links out to them.
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
  /** D-ORG-3 — a host-level link to another SPA on this host (App Home /org/),
   *  rendered as a plain anchor so the ATS router basename is not applied. */
  readonly external?: boolean;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const SOON = { text: 'Soon', soon: true } as const;

export const SETTINGS_NAV: readonly NavGroup[] = [
  {
    // D-ORG-3 — organization-owned administration (profile, sites, domain, users,
    // roles, security, billing, audit) lives on the App Home at /org/*. The ATS
    // settings rail links OUT to it (a host-level anchor — it is a different SPA
    // beside this one, not an ATS route). Nothing organization-owned is
    // duplicated here.
    heading: 'Organization',
    items: [
      {
        key: 'organization',
        label: 'Organization administration',
        icon: <IconBuilding />,
        to: '/org/',
        match: '/org',
        status: 'live',
        external: true,
      },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      {
        key: 'branches',
        label: 'Teams & organisation',
        icon: <IconBranch />,
        to: '/admin/settings/branches',
        match: '/admin/settings/branches',
        status: 'live',
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
        // D-EMAIL-TPL-1 (ET-6) — LIVE: tenant email-template management (system
        // default + override). Notification preferences remain deferred (D-9).
        key: 'email',
        label: 'Email & notifications',
        icon: <IconMail />,
        to: '/admin/settings/email',
        match: '/admin/settings/email',
        status: 'live',
      },
    ],
  },
  {
    // COMM-C3 — Engagement Policy is a recruiting governance control (the Submit-
    // to-Client enforcement boundary). It answers "what evidence is required?";
    // provider setup ("how is evidence produced?") stays under Integrations.
    heading: 'Recruiting',
    items: [
      {
        key: 'engagement-policy',
        label: 'Engagement policy',
        icon: <IconShieldCheck />,
        to: '/admin/settings/engagement-policy',
        match: '/admin/settings/engagement-policy',
        status: 'live',
      },
      {
        // Recruiting-behaviour defaults (Compensation display + the financials
        // grant + Resume extraction) — the ATS landing section (the /admin index
        // redirects here since D-ORG-3 moved the organization profile to /org).
        key: 'recruiting-settings',
        label: 'Recruiting settings',
        icon: <IconSliders />,
        to: '/admin/settings/recruiting',
        match: '/admin/settings/recruiting',
        status: 'live',
      },
    ],
  },
  {
    // DOC-TEMPLATE-ADMIN-RTR-1 (§5) — tenant document-template governance. Placed
    // AFTER Recruiting, before Data (prototype IA). Right to Represent is the one
    // tenant-configurable type this increment; others listed honestly. The NEW tag
    // marks the freshly-live section. document_template:read/:manage gate it.
    heading: 'Documents',
    items: [
      {
        key: 'document-templates',
        label: 'Document templates',
        icon: <IconFile />,
        to: '/admin/settings/document-templates',
        match: '/admin/settings/document-templates',
        status: 'live',
        badge: { text: 'New', soon: false },
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
    // The mockup's 7th group ("Connect"). LIVE as of T10-B1/F-010: the
    // Integrations section hosts requisition-ingestion monitoring (T8-P3,
    // `requisition:import:read`) and connector connection management
    // (T8-CONNECTOR-A, `integration:read`) — real substrate, so the stale
    // "Soon" badge is dropped. This does NOT imply Connector-B, provider
    // selection, or production onboarding (those remain out of scope).
    heading: 'Connect',
    items: [
      {
        key: 'integrations',
        label: 'Integrations',
        icon: <IconPlug />,
        to: '/admin/settings/integrations',
        match: '/admin/settings/integrations',
        status: 'live',
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
  if (item.external) {
    return (
      <a href={item.to} className="set-navbtn" data-testid={`settings-nav-${item.key}`}>
        {item.icon}
        <span>{item.label}</span>
      </a>
    );
  }
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
