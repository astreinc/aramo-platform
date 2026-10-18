import type { ReactNode } from 'react';

import { NavCollapseProvider, useNavCollapse } from './nav-collapse';
import './app-rail.css';

// The shared Aramo page grid: <rail 236 / 64> <main>. Moved from
// apps/ats-web/src/shell/AtsAppShell.tsx (move-not-fork) so App Home,
// Organization administration and the ATS render ONE shell. The rail always
// pushes the content (no overlay / hover-peek); the column width animates with
// the shared collapse preference (nav-collapse.tsx). The main column keeps the
// TopBar + <main id="rc-main-content"> landmark contract.

interface AramoAppShellProps {
  readonly rail: ReactNode;
  readonly topBar: ReactNode;
  readonly children: ReactNode;
}

export function AramoAppShell(props: AramoAppShellProps): JSX.Element {
  return (
    <NavCollapseProvider>
      <AramoAppGrid {...props} />
    </NavCollapseProvider>
  );
}

function AramoAppGrid({ rail, topBar, children }: AramoAppShellProps): JSX.Element {
  const { collapsed } = useNavCollapse();
  return (
    <div className={`ats-app${collapsed ? ' ats-app--collapsed' : ''}`}>
      {/* Skip-navigation (T10-B1) — the first focusable element; targets <main>. */}
      <a className="rc-skip-link" href="#rc-main-content">
        Skip to main content
      </a>
      {rail}
      <div className="rc-main">
        {topBar}
        <main id="rc-main-content" className="rc-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
