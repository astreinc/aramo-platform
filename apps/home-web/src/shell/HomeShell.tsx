import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AppSwitcher,
  AramoAppShell,
  AramoRail,
  Breadcrumb,
  IconSliders,
  IconColumns,
  TopBar,
  UserMenu,
  buildAppSwitcherItems,
  initialsOf,
  logout,
  useMyProducts,
  type Session,
} from '@aramo/fe-foundation';
import { hasOrgAdminScope, orgSectionLabel, useMe } from '@aramo/org-admin-web';

// The App Home + Organization administration chrome — the SAME shared Aramo
// shell as the ATS (AramoAppShell + AramoRail, one collapse preference), per the
// accepted App Home handoff §3:
//   rail     PLATFORM · App Home, Organization (organization admins only)
//   top bar  page title (or Organization / <section>) · app switcher ·
//            organization name · account menu
// Product-neutral: no product navigation lives here; products open from the App
// Home cards or the app switcher, and each product checks access itself.

const ICON_HOME = 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z';
const ICON_ORG = 'M4 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 10h5a1 1 0 0 1 1 1v10M2 21h20';

interface HomeShellProps {
  readonly session: Session;
  readonly children: ReactNode;
}

function TitleFor({ pathname }: { readonly pathname: string }) {
  if (pathname.startsWith('/org')) {
    const key = pathname.replace(/^\/org\/?/, '').split('/')[0] ?? '';
    const label = orgSectionLabel(key);
    return <Breadcrumb items={label === null ? [{ label: 'Organization' }] : [{ label: 'Organization', href: '/org/profile' }, { label }]} />;
  }
  return <span className="home-topbar-title">{pathname.startsWith('/preferences') ? 'My preferences' : 'App Home'}</span>;
}

export function HomeShell({ session, children }: HomeShellProps) {
  const me = useMe();
  const products = useMyProducts();
  const { pathname } = useLocation();
  const [switcherSignal, setSwitcherSignal] = useState(0);
  const isOrgAdmin = hasOrgAdminScope(session);
  const displayName = me?.user.display_name ?? me?.user.email ?? '';
  const tenantName = me?.tenant.display_name ?? null;
  const current = pathname.startsWith('/org') ? 'org' : 'home';

  const rail = (
    <AramoRail
      sections={[
        {
          label: 'Platform',
          kind: 'primary',
          items: [
            { key: 'home', to: '/', label: 'App Home', iconPath: ICON_HOME },
            ...(isOrgAdmin ? [{ key: 'org', to: '/org/profile', label: 'Organization', iconPath: ICON_ORG }] : []),
          ],
        },
      ]}
      activeKey={pathname.startsWith('/org') ? 'org' : pathname === '/' ? 'home' : null}
      userInitials={initialsOf(displayName || '?')}
      userName={displayName}
      tenantName={tenantName}
      homeTo="/"
      homeLabel="App Home"
    />
  );

  const topBar = (
    <TopBar>
      <TitleFor pathname={pathname} />
      <div className="home-topbar-spacer" />
      <AppSwitcher
        organizationName={tenantName}
        items={buildAppSwitcherItems({ current, products: products.status === 'ready' ? products.view : null })}
        openSignal={switcherSignal}
      />
      {tenantName !== null ? (
        <span className="rc-orglabel" title={tenantName}>
          {tenantName}
        </span>
      ) : null}
      <UserMenu
        name={displayName}
        email={me?.user.email ?? ''}
        roleLine={null}
        roleBadge={isOrgAdmin ? 'ADMIN' : 'MEMBER'}
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

