import { useNavigate } from 'react-router-dom';
import { hasScope, logout, redirectToLogin, type Session } from '@aramo/fe-foundation';

import { AccessDenied, COMMERCIAL_PERMISSIONS, PLATFORM_PERMISSIONS, permissionLabel } from '../components';
import { useIdentity } from '../identity/identity';

import { COMMERCIAL_ROLE_KEYS, commercialRoleLabel } from './commercial-model';

// CCP-B1 — the in-shell access-denied state for a Commercial route (CCP-UI v1.0
// handoff §2 "Deep links"; PLATFORM-UX-1 R-5 via Amendment A1-4). A super_admin deep
// link (or any account without the page's commercial read scope) renders this
// INSIDE the shell, with no redirect: "No access", "This account can't open
// Commercial {page}", the signed-in email, the current role, the six roles that
// grant access as chips, and the missing permission (R-5). Actions: Sign in with a
// different account, Sign out (R-5) and Back to dashboard (R-5, only with
// platform:tenant:read).

export interface CommercialAccessDeniedProps {
  readonly session: Session;
  /** The scope the page needs. */
  readonly scope: string;
  /** The page name, lower case ("approvals"). */
  readonly page: string;
}

export const SUPER_ADMIN_WHY = 'Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role.';
export const NO_COMMERCIAL_ROLE_WHY = 'Commercial screens are open only to people with a commercial role.';
export const MISSING_PAGE_WHY = 'Your roles don’t include access to this page.';
export const DENIED_FOOT = 'Tenant operations are unchanged for this account. Commercial authority is held only by the commercial roles above.';

export function CommercialAccessDenied({ session, scope, page }: CommercialAccessDeniedProps) {
  const identity = useIdentity();
  const navigate = useNavigate();
  // No commercial scope at all → the account holds no commercial role.
  const noCommercialRole = !hasScope(session, COMMERCIAL_PERMISSIONS.approvalRead);
  const superAdmin = identity.role !== null && identity.role.split(', ').includes('Super admin');
  const why = noCommercialRole ? (superAdmin ? SUPER_ADMIN_WHY : NO_COMMERCIAL_ROLE_WHY) : MISSING_PAGE_WHY;
  return (
    <AccessDenied
      variant="ccp"
      what={`Commercial ${page}`}
      explanation={why}
      email={identity.email}
      role={identity.role}
      grants={COMMERCIAL_ROLE_KEYS.map(commercialRoleLabel)}
      permission={{ label: permissionLabel(scope), code: scope }}
      footnote={DENIED_FOOT}
      onSwitchAccount={() => redirectToLogin({ selectAccount: true })}
      onSignOut={() => void logout()}
      onBackToDashboard={hasScope(session, PLATFORM_PERMISSIONS.tenantRead) ? () => navigate('/') : undefined}
    />
  );
}
