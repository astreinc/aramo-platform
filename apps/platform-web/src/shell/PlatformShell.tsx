import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AppShell,
  Button,
  Rail,
  RailNavLabel,
  RailUser,
  TopBar,
  hasScope,
  logout,
  redirectToLogin,
  useRailCollapse,
  type Session,
} from '@aramo/fe-foundation';

import markUrl from '../assets/aramo-mark-white.svg';
import { EnvironmentBar, type EnvironmentContext } from '../components/EnvironmentBar';
import { IdentityProvider, useIdentity, type LoadMe } from '../identity/identity';

import { AccountMenu } from './AccountMenu';
import { CommandPalette, type PaletteSources } from './CommandPalette';
import { CrumbProvider, useCrumbEntity } from './crumbs';
import { crumbsFor, navKeyFor, visibleNavGroups } from './nav';
import { NavIcon, PanelIcon, SearchIcon } from './nav-icons';
import './platform-shell.css';

// PLATFORM-UX-1 F-2 — the platform console chrome (handoff §3; directive R-1,
// R-5, R-6). The shared AppShell (collapse key `rc-rail-collapsed`, ⌘/Ctrl+\
// toggle, skip link, single <main>) themed midnight entirely through
// platform-web tokens + platform-scoped CSS (platform-shell.css), with:
//   - the terracotta environment bar on top ("Signed in as …"),
//   - the rail header (white mark, "aramo.ai", the PLATFORM tag — "P" collapsed),
//     the permission-filtered groups (empty groups hidden) and the footer avatar,
//   - the top bar: breadcrumb ending in the entity name, the PLATFORM marker, the
//     ⌘K palette and the account menu.
// AramoRail / app-rail.css are not used or touched.

export interface PlatformShellProps {
  readonly session: Session;
  readonly children: ReactNode;
  /** The environment-bar context line. Default: studio on /document-templates/:id (the Studio), else console. */
  readonly environment?: EnvironmentContext;
  /** Test seam: the /platform/me loader. */
  readonly loadMe?: LoadMe;
  /** Test seam: the command-palette list readers. */
  readonly paletteSources?: PaletteSources;
}

export function PlatformShell({ session, children, environment, loadMe, paletteSources }: PlatformShellProps) {
  return (
    <IdentityProvider session={session} load={loadMe}>
      <CrumbProvider>
        <ShellFrame session={session} environment={environment} paletteSources={paletteSources}>
          {children}
        </ShellFrame>
      </CrumbProvider>
    </IdentityProvider>
  );
}

function RailHeader() {
  const { collapsed, toggle } = useRailCollapse();
  return (
    <>
      <div className="pw-rail-head">
        <Button
          unstyled
          className="pw-rail-logo"
          title="Aramo"
          aria-label={collapsed ? 'Expand sidebar' : 'Aramo'}
          onClick={() => {
            if (collapsed) toggle();
          }}
        >
          <img src={markUrl} width={25} height={25} alt="" />
        </Button>
        <span className="pw-rail-name">
          aramo<span className="pw-rail-name__tld">.ai</span>
        </span>
        <Button
          unstyled
          className="pw-rail-collapse"
          title="Collapse sidebar (⌘\)"
          aria-label="Collapse sidebar"
          onClick={toggle}
        >
          <PanelIcon />
        </Button>
      </div>
      <div className="pw-rail-tagrow">
        <span className="pw-rail-tag" title="Platform admin console">
          <span className="pw-rail-tag__full">PLATFORM</span>
          <span className="pw-rail-tag__short" aria-hidden="true">
            P
          </span>
        </span>
      </div>
    </>
  );
}

interface ShellFrameProps {
  readonly session: Session;
  readonly environment?: EnvironmentContext;
  readonly paletteSources?: PaletteSources;
  readonly children: ReactNode;
}

function ShellFrame({ session, environment, paletteSources, children }: ShellFrameProps) {
  const identity = useIdentity();
  const entity = useCrumbEntity();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const can = useCallback((scope: string) => hasScope(session, scope), [session]);
  const groups = visibleNavGroups(can);
  const activeKey = navKeyFor(pathname);
  const crumbs = crumbsFor(pathname, entity);

  // ⌘K / Ctrl+K opens the palette (⌘\ is AppShell's rail toggle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const switchAccount = (): void => redirectToLogin({ selectAccount: true });
  const signOut = (): void => {
    void logout();
  };

  const rail = (
    <Rail
      user={
        <RailUser
          initials={identity.initials}
          name={identity.name}
          role={identity.role ? `${identity.role} · ${identity.tenant}` : identity.tenant}
        />
      }
    >
      <RailHeader />
      {groups.map((g) => (
        <div key={g.label} className="pw-rail-group">
          <RailNavLabel>{g.label}</RailNavLabel>
          <span className="pw-rail-divider" aria-hidden="true" />
          {g.items.map((item) => {
            const current = item.key === activeKey;
            return (
              <Link
                key={item.key}
                to={item.to}
                className="rc-nav__item pw-nav-item"
                aria-current={current ? 'page' : undefined}
                title={item.label}
              >
                <NavIcon name={item.icon} />
                <span className="pw-nav-item__label">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </Rail>
  );

  const topBar = (
    <TopBar>
      <nav aria-label="Breadcrumb" className="pw-crumbs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} className="pw-crumbs__step">
              {last ? (
                <span aria-current="page" className="pw-crumbs__here">
                  {c.label}
                </span>
              ) : c.to ? (
                <Link to={c.to} className="pw-crumbs__link">
                  {c.label}
                </Link>
              ) : (
                <span className="pw-crumbs__link">{c.label}</span>
              )}
              {last ? null : (
                <span className="pw-crumbs__sep" aria-hidden="true">
                  /
                </span>
              )}
            </span>
          );
        })}
      </nav>
      <span className="pw-topbar-mark">PLATFORM</span>
      <Button unstyled className="pw-cmdk-trigger" aria-label="Search (⌘K)" onClick={() => setPaletteOpen(true)}>
        <SearchIcon size={15} />
        <span className="pw-cmdk-trigger__text">Tenants, skills, templates</span>
        <span className="pw-cmdk-trigger__key" aria-hidden="true">
          ⌘K
        </span>
      </Button>
      <AccountMenu identity={identity} onSwitchAccount={switchAccount} onSignOut={signOut} />
    </TopBar>
  );

  return (
    <div className="pw-shell">
      <EnvironmentBar
        email={identity.email}
        tenant={identity.tenant}
        role={identity.role}
        context={environment ?? (/^\/document-templates\/[^/]+\/?$/.test(pathname) ? 'studio' : 'console')}
      />
      <AppShell rail={rail} topBar={topBar}>
        {children}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        can={can}
        onNavigate={(to) => navigate(to)}
        sources={paletteSources}
      />
    </div>
  );
}
