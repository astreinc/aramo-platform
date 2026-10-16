import type { ReactNode } from 'react';

import { NavCollapseProvider, useNavCollapse } from './nav-collapse';
import './app-rail.css';

// The ats-web page grid: <rail 236 / 64> <main>. The rail always pushes the
// content (no overlay / hover-peek); the column width animates with the shared
// collapse preference (nav-collapse.tsx). The main column keeps the existing
// TopBar + <main id="rc-main-content"> landmark contract.

interface AtsAppShellProps {
  readonly rail: ReactNode;
  readonly topBar: ReactNode;
  readonly children: ReactNode;
}

export function AtsAppShell(props: AtsAppShellProps): JSX.Element {
  return (
    <NavCollapseProvider>
      <AtsAppGrid {...props} />
    </NavCollapseProvider>
  );
}

function AtsAppGrid({ rail, topBar, children }: AtsAppShellProps): JSX.Element {
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
