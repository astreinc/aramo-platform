import type { ReactNode } from 'react';
import {
  AppShell,
  Icons,
  Rail,
  RailNavItem,
  RailNavLabel,
  ShellBrand,
  TopBar,
  UserMenu,
  logout,
  type Session,
} from '@aramo/fe-foundation';
import { hasOrgAdminScope, useMe } from '@aramo/org-admin-web';

// D-ORG-2 — the App Home chrome. Reuses the extracted fe-foundation AppShell
// kit (rail + topbar + user menu) — zero locally-defined chrome, the same kit
// platform-web composes. Product-neutral: no ATS nav, no product entry other
// than the tiles. The Organization entry shows only to a principal holding an
// organization permission (the UI hide is UX; OrgAdminRoutes + the server gate).
interface HomeShellProps {
  readonly session: Session;
  readonly children: ReactNode;
}

export function HomeShell({ session, children }: HomeShellProps) {
  const me = useMe();
  const isOrgAdmin = hasOrgAdminScope(session);
  const displayName = me?.user.display_name ?? me?.user.email ?? '';
  const roleLine = me && me.roles.length > 0 ? me.roles.join(' · ') : null;
  const handleSignOut = (): void => {
    void logout();
  };

  const rail = (
    <Rail>
      <RailNavLabel>Aramo</RailNavLabel>
      <RailNavItem to="/" end label="App Home" icon={<Icons.IconDesk />} />
      {isOrgAdmin ? (
        <RailNavItem to="/org" label="Organization" icon={<Icons.IconBuilding />} />
      ) : null}
    </Rail>
  );

  const topBar = (
    <TopBar>
      <ShellBrand brand="Aramo" brandSub="App Home" to="/" />
      <div className="home-topbar-spacer" />
      {me ? (
        <span className="rc-orglabel" title={me.tenant.display_name}>
          {me.tenant.display_name}
        </span>
      ) : null}
      <UserMenu
        name={displayName}
        email={me?.user.email ?? ''}
        roleLine={roleLine}
        onSignOut={handleSignOut}
        settingsHref={isOrgAdmin ? '/org/profile' : undefined}
      />
    </TopBar>
  );

  return (
    <AppShell rail={rail} topBar={topBar}>
      {children}
    </AppShell>
  );
}
