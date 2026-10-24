import { useNavigate } from 'react-router-dom';
import { hasScope, logout, redirectToLogin, type Session } from '@aramo/fe-foundation';

import { AccessDenied } from '../components/AccessDenied';
import { PLATFORM_PERMISSIONS as P, permissionLabel } from '../components/permissions';
import { useIdentity } from '../identity/identity';

// PLATFORM-UX-1 F-2 (directive R-5) — the in-shell access-denied state for the
// console entry gate (platform:tenant:read) and every per-route gate. It replaces
// ForbiddenState in platform-web: it renders INSIDE PlatformShell with the
// signed-in identity (the session fallback when /platform/me is refused) and
// never redirects on its own.

export interface PlatformAccessDeniedProps {
  readonly session: Session;
  /** The permission the screen needs. */
  readonly scope: string;
  /** The page name ("Registry"); omit for the console entry gate. */
  readonly page?: string;
}

export function PlatformAccessDenied({ session, scope, page }: PlatformAccessDeniedProps) {
  const identity = useIdentity();
  const navigate = useNavigate();
  const entry = page === undefined;
  const canHome = !entry && hasScope(session, P.tenantRead);
  return (
    <AccessDenied
      what={entry ? 'Platform administration' : page}
      explanation={
        entry
          ? 'You’re signed in with a tenant account. Platform administration is only for Aramo staff accounts with platform permissions.'
          : 'Your account can use other parts of the console, but not this page.'
      }
      email={identity.email}
      organization={identity.tenant}
      permission={{ label: permissionLabel(scope), code: scope }}
      onSwitchAccount={() => redirectToLogin({ selectAccount: true })}
      onSignOut={() => void logout()}
      onBackToDashboard={canHome ? () => navigate('/') : undefined}
    />
  );
}
