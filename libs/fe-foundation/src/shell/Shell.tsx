import type { ReactNode } from 'react';

import { hasScope } from '../auth/scopes';
import { logout, type Session } from '../auth/session';
import { Button } from '../components/Button';
import { NavLink } from '../components/NavLink';

export interface ShellNavItem {
  readonly to: string;
  readonly label: string;
  // When set, the nav item is rendered only if the session carries the
  // scope. Mirrors S5a's nav-boundary scope-gating contract.
  readonly requireScope?: string;
}

interface ShellProps {
  session: Session;
  children: ReactNode;
  // Header brand text. Domain-neutral default so a forgotten brand
  // still ships a coherent header; each console passes its own.
  brand?: string;
  // Nav items rendered below the header. The Home link is always
  // rendered first; each provided item is scope-gated when
  // `requireScope` is set.
  navItems?: readonly ShellNavItem[];
  // Test seam.
  onLogoutComplete?: () => void;
}

export function Shell({
  session,
  children,
  brand = 'Aramo',
  navItems,
  onLogoutComplete,
}: ShellProps) {
  // §5 Auth-Hardening D3: delegate to the shared session logout, which clears
  // the LOCAL session (POST /logout) then navigates to the Cognito hosted-UI
  // /logout to terminate the SSO session. R10/R12: no internal detail is
  // surfaced; the outcome is identical on success or failure.
  const handleLogout = () => logout(onLogoutComplete);

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <span className="app-shell__brand">{brand}</span>
        <span className="app-shell__tenant" data-testid="shell-tenant-id">
          Tenant: {session.tenant_id}
        </span>
        <Button variant="secondary" size="sm" onClick={handleLogout}>
          Log out
        </Button>
      </header>
      <nav className="app-shell__nav" aria-label="Primary">
        <NavLink to="/" end>
          Home
        </NavLink>
        {navItems?.map((item) =>
          item.requireScope === undefined ||
          hasScope(session, item.requireScope) ? (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ) : null,
        )}
      </nav>
      <main className="app-shell__main">{children}</main>
    </div>
  );
}
