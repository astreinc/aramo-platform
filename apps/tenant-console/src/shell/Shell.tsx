import type { ReactNode } from 'react';

import { apiClient } from '../api/client';
import { LOGIN_PATH, LOGOUT_PATH, type Session } from '../auth/session';

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
    <div className="aramo-shell">
      <header className="aramo-shell__header">
        <span className="aramo-shell__brand">Aramo Tenant Console</span>
        <span
          className="aramo-shell__tenant"
          data-testid="shell-tenant-id"
        >
          Tenant: {session.tenant_id}
        </span>
        <button
          type="button"
          className="aramo-shell__logout"
          onClick={handleLogout}
        >
          Log out
        </button>
      </header>
      <main className="aramo-shell__main">{children}</main>
    </div>
  );
}
