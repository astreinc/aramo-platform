import type { ReactNode } from 'react';

import { apiClient } from '../api/client';
import { hasScope } from '../auth/scopes';
import { LOGIN_PATH, LOGOUT_PATH, type Session } from '../auth/session';
import { Button } from '../components/Button';
import { NavLink } from '../components/NavLink';

interface ShellProps {
  session: Session;
  children: ReactNode;
  // Test seam.
  onLogoutComplete?: () => void;
}

export function Shell({ session, children, onLogoutComplete }: ShellProps) {
  const handleLogout = async () => {
    try {
      await apiClient.post(LOGOUT_PATH);
    } catch {
      // R10/R12: do not surface internal error details to the UI; the
      // user's outcome (redirect to login) is the same on success or
      // failure.
    }
    (onLogoutComplete ?? (() => window.location.assign(LOGIN_PATH)))();
  };

  return (
    <div className="tc-shell">
      <header className="tc-shell__header">
        <span className="tc-shell__brand">Aramo · Tenant Console</span>
        <span className="tc-shell__tenant" data-testid="shell-tenant-id">
          Tenant: {session.tenant_id}
        </span>
        <Button variant="secondary" size="sm" onClick={handleLogout}>
          Log out
        </Button>
      </header>
      <nav className="tc-shell__nav" aria-label="Primary">
        <NavLink to="/" end>
          Home
        </NavLink>
        {hasScope(session, 'tenant:admin:user-manage') && (
          <NavLink to="/users">Users</NavLink>
        )}
        {hasScope(session, 'org:manage') && (
          <NavLink to="/org">Organisation</NavLink>
        )}
        {hasScope(session, 'tenant:admin:settings') && (
          <NavLink to="/settings">Settings</NavLink>
        )}
      </nav>
      <main className="tc-shell__main">{children}</main>
    </div>
  );
}
