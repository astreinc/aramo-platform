import { useCallback, type ReactNode } from 'react';
import { UserMenu, logout, safeErrorMessage, useCompactRailPage } from '@aramo/fe-foundation';
import type { StudioAccountSlot } from '@aramo/document-templates-web';

import { useMe } from '../me-api';

import './studio-theme.css';

// TEMPLATE-STUDIO-1 S-1 (directive §2 Theming, §3.2) — the Organization host frame of the
// shared Template Studio, reused by every Org route that renders the Studio (a tenant
// template — S-1; the read-only Aramo-default preview — S-2):
//   • the --ts-* → --ox-* token map (studio-theme.css, scoped to .ox-studio);
//   • the nav opens collapsed below 1280px (useCompactRailPage; the shared
//     aramo.nav.collapsed preference still applies at 1280px and wider);
//   • the account slot (the Organization account menu; unsaved changes are saved first);
//   • a stable refusal formatter (the Studio reloads when its formatter changes).
// The Org shell's full-width mode itself is path-driven (sections.ts isOrgStudioPath).

export function OrgStudioHost({ testId, children }: { readonly testId?: string; readonly children: ReactNode }) {
  useCompactRailPage();
  return (
    <div className="ox-studio" data-testid={testId}>
      {children}
    </div>
  );
}

/** The Studio's refusal → message formatter in the Organization context (stable). */
export function orgStudioErrorMessage(e: unknown, fallback: string): string {
  return safeErrorMessage(e, fallback);
}

/** The Studio account slot: the Organization account menu (badge as HomeShell). */
export function useOrgStudioAccount(admin: boolean): (slot: StudioAccountSlot) => ReactNode {
  const me = useMe();
  return useCallback(
    ({ beforeLeave }: StudioAccountSlot) => (
      <UserMenu
        name={me?.user.display_name ?? me?.user.email ?? ''}
        email={me?.user.email ?? ''}
        roleLine={me?.tenant.display_name ?? null}
        roleBadge={admin ? 'ADMIN' : 'MEMBER'}
        onSignOut={() => void beforeLeave(() => void logout())}
      />
    ),
    [me, admin],
  );
}
