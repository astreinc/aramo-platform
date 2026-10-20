import {
  AppSwitcher,
  IconColumns,
  IconSliders,
  IconUser,
  buildAppSwitcherItems,
  hasScope,
  logout,
  useMyProducts,
  productByKey,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useState, type ReactNode } from 'react';

import { hasAdminScope } from '../admin/admin-access';
import { getRequisitionCount, getTalentCount } from '../reporting/counts-api';
import {
  CmdKSearch,
  NotificationButton,
  TopBar,
  UserMenu,
  initialsOf,
} from '../ui';
import { CommandPalette } from '../search/CommandPalette';
import { SignSubscriptionProvider } from '../rtr/rtr-access';

import { AppRail, type RailItem, type RailKey } from './AppRail';
import { AtsAppShell } from './AtsAppShell';
// BreadcrumbProvider is retained so routed detail views may still publish their
// entity title via useEntityCrumb (that publication is covered by their specs);
// the app shell no longer RENDERS a route/section title in the TopBar — the
// authoritative page title is each page's own H1/PageHeader, and the left rail
// already communicates the active module (enterprise "one H1" ruling). The
// TopBar keeps only global utilities: ⌘K search, notifications, tenant/user
// context, and account controls.
import { BreadcrumbProvider } from './breadcrumb';
import { useMe } from './me-api';

// Unified multi-product shell — the shared account page (App Home, a sibling SPA
// on this host; a host-level href, never an ATS route).
const MY_PREFERENCES_HREF = '/preferences';
// ATS personal settings (connected Microsoft mailbox) — every signed-in user
// (NOT admin-gated). The account menu's "My ATS settings" row. The admin
// Settings area is reached from the rail (Administration → Settings).
const MY_SETTINGS_PATH = '/settings/me';

// RecruiterShell — Phase 2A. The app-layer chrome that REPLACES the frozen
// fe-foundation Shell (non-consumption, Lead-approved). Composes AtsAppShell +
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
  readonly key: RailKey;
  readonly to: string;
  readonly label: string;
  /** Scope-gate; omitted = always visible (the view gates internally). */
  readonly scope?: string;
}

// Shared main nav (app rail) — order and labels per the rail spec:
// My desk · Requisitions · Placements · Talent · Companies · Contacts, then WORK
// (Sourcing · Tasks · Identity Advisories · Portal Disputes · Trust Proposals ·
// Reports), then ADMINISTRATION (Settings). Each item stays gated on its route's
// existing scope (no NavLink, no fetch without it). Search lives in the top-bar
// ⌘K, not the rail; unfinished talent is recovered inside Talent (no rail item).
const PRIMARY_NAV: readonly NavItem[] = [
  { key: 'desk', to: '/', label: 'My desk', scope: 'dashboard:read' },
  { key: 'requisitions', to: '/requisitions', label: 'Requisitions', scope: 'requisition:read' },
  { key: 'placements', to: '/placements', label: 'Placements', scope: 'pipeline:read' },
  { key: 'talent', to: '/talent', label: 'Talent', scope: 'talent:read' },
  { key: 'companies', to: '/companies', label: 'Companies', scope: 'company:read' },
  { key: 'contacts', to: '/contacts', label: 'Contacts', scope: 'contact:read' },
];

const WORK_NAV: readonly NavItem[] = [
  { key: 'sourcing', to: '/sourcing', label: 'Sourcing', scope: 'talent:source' },
  { key: 'tasks', to: '/tasks', label: 'Tasks', scope: 'task:read' },
  { key: 'advisories', to: '/identity/advisories', label: 'Identity Advisories', scope: 'identity:resolve' },
  { key: 'disputes', to: '/identity/portal-disputes', label: 'Portal Disputes', scope: 'identity:resolve' },
  { key: 'proposals', to: '/trust/proposals', label: 'Trust Proposals', scope: 'talent:read' },
  { key: 'reports', to: '/reports', label: 'Reports', scope: 'report:read' },
];

// Admin section — shown only to a principal holding a `tenant:admin:*` scope
// (hasAdminScope); lands on /admin (the Settings shell).
const ADMIN_NAV: readonly NavItem[] = [{ key: 'settings', to: '/admin', label: 'Settings' }];

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
  const me = useMe();

  // The resolved /me display data (loading-safe — `me` is null until the fetch
  // resolves and stays null on error). Name falls back display_name → email;
  // the role line joins ALL roles ("Tenant Admin · Recruiter"); both the menu
  // and the rail footer read from the SAME source (no more consumer_type label).
  const displayName = me ? me.user.display_name ?? me.user.email : null;
  // FULL role line (all roles) — for the roomy top-right account menu.
  const roleLine =
    me && me.roles.length > 0 ? me.roles.join(' · ') : null;
  // Rail footer: real identity once loaded; neutral placeholders while in
  // flight so the chrome (avatar slot + logout) never collapses.
  const railName = displayName ?? '—';
  const railInitials = displayName ? initialsOf(displayName) : '·';

  // §5 Auth-Hardening D3: the shared session logout — clears the LOCAL session
  // (POST /logout) then navigates to the Cognito hosted-UI /logout to terminate
  // the SSO session. Identical for the recruiter AND admin surfaces (both ride
  // this one shell + one session). Same outcome on success/failure; never
  // surface internals (R10/R12).
  const handleLogout = () => logout(onLogoutComplete);

  // Enterprise Search GS-1 — the global ⌘K / Ctrl-K command palette. A keyboard-first entry
  // into the SAME /v1/search authority as the full Search page (the palette is a lean consumer
  // of that contract, not a second search). ⌘K opens it; the palette owns Escape/close.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Unified multi-product shell — the app switcher (accepted change log A6) reads
  // the SAME backend-authoritative availability as App Home; the account menu's
  // "Switch application" opens it.
  const products = useMyProducts();
  const signSubscribed = products.status === 'ready' ? (productByKey(products.view, 'sign')?.subscribed ?? false) : null;
  const [switcherSignal, setSwitcherSignal] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // P2-A (REQ-PIXEL-PARITY-1-A2) — rail nav count pills. Truthful counts from
  // the report endpoints (report:read-gated; skipped without the scope).
  // Requisitions total is A3-scoped; talent is tenant-wide. Degrades silently
  // (no pill on failure). The Tasks count is P2-C (no substrate yet).
  const [navCounts, setNavCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!hasScope(session, 'report:read')) return;
    let cancelled = false;
    void Promise.allSettled([getRequisitionCount(), getTalentCount()]).then(
      ([req, tal]) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        if (req.status === 'fulfilled') next['/requisitions'] = req.value;
        if (tal.status === 'fulfilled') next['/talent'] = tal.value;
        setNavCounts(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session]);

  const railItems = (items: readonly NavItem[]): RailItem[] =>
    items
      .filter((item) => item.scope === undefined || hasScope(session, item.scope))
      .map((item) => ({ key: item.key, to: item.to, label: item.label, count: navCounts[item.to] }));

  // The ONE shared main nav (app rail). Sign out lives in the top-right avatar
  // menu (UserMenu); the rail footer shows identity + tenant only.
  const rail = (
    <AppRail
      primary={railItems(PRIMARY_NAV)}
      work={railItems(WORK_NAV)}
      admin={hasAdminScope(session) ? railItems(ADMIN_NAV) : []}
      userInitials={railInitials}
      userName={railName}
      tenantName={me?.tenant.display_name ?? null}
    />
  );

  const topBar = (
    <TopBar>
      <CmdKSearch onActivate={() => setPaletteOpen(true)} />
      <NotificationButton />
      {/* Org-context label (M365 pattern) — the tenant display_name as plain
          text, NOT a logo. The internal brand stays pure-Aramo (ShellBrand);
          the tenant appears ONLY here. Hidden until /me resolves. */}
      <AppSwitcher
        organizationName={me?.tenant.display_name ?? null}
        items={buildAppSwitcherItems({ current: 'ats', products: products.status === 'ready' ? products.view : null })}
        openSignal={switcherSignal}
      />
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
        roleBadge={hasAdminScope(session) ? 'ADMIN' : 'MEMBER'}
        items={[
          // The shared account page lives on App Home (a sibling SPA on this host).
          { key: 'prefs', label: 'My preferences', sub: 'Start page · App Home', icon: <IconSliders />, href: MY_PREFERENCES_HREF },
          // ATS-only personal settings (connected Microsoft mailbox).
          { key: 'my-ats', label: 'My ATS settings', sub: 'Connected accounts', icon: <IconUser />, to: MY_SETTINGS_PATH },
          { key: 'switch', label: 'Switch application', icon: <IconColumns />, onSelect: () => setSwitcherSignal((n) => n + 1) },
        ]}
      />
    </TopBar>
  );

  // Inc-3 PR-3.5 (Workstream C) — OFFBOARDING winding-down banner. Persistent,
  // dismissal-free (the state is not something a user should be able to hide).
  // Driven by /me's tenant.status (loading-safe: `me` is null until /me resolves
  // → no banner flicker). ACTIVE (and every other status) renders nothing;
  // SUSPENDED/CLOSED users cannot be in-app past the mint gate, so the banner is
  // the only in-app lifecycle treatment. No date is shown — the payload is not
  // expanded for it in this PR; the copy degrades gracefully without it.
  const offboarding = me?.tenant.status === 'OFFBOARDING';

  return (
    <AtsAppShell rail={rail} topBar={topBar}>
      {offboarding ? (
        <div className="rc-offboarding-banner" role="status">
          <strong>This workspace is winding down.</strong> Your organization is
          being offboarded. Please contact your provider with any questions about
          access or your data.
        </div>
      ) : null}
      {/* RTR execution needs the tenant's Sign subscription (rtr-access.tsx). */}
      <SignSubscriptionProvider subscribed={signSubscribed}>{children}</SignSubscriptionProvider>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </AtsAppShell>
  );
}
