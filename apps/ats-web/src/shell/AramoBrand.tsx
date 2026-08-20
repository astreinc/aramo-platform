import { useRailCollapse } from '@aramo/fe-foundation';
import { Link } from 'react-router-dom';

// REQ-PIXEL-PARITY-1 (+A1) — the app-level rail brand, rendered at the TOP OF
// THE RAIL. The prototype's "aramo.ai" wordmark + sun/asterisk mark live here
// (NOT in the frozen fe-foundation ShellBrand). It also hosts the ChatGPT-style
// collapse control INSIDE the rail:
//   • expanded  → logo + wordmark (home link) on the left, a panel collapse
//                 button on the right.
//   • collapsed → only the logo; hovering it swaps to the panel icon with an
//                 "Open sidebar" tooltip; clicking expands.
// The collapse state comes from the fe-foundation RailCollapseContext.

function AramoMark() {
  return (
    <svg width="25" height="25" viewBox="0 0 64 64" aria-hidden="true">
      <g stroke="#ffffff" strokeWidth="5" strokeLinecap="round">
        <line x1="43" y1="32" x2="56" y2="32" />
        <line x1="32" y1="43" x2="32" y2="56" />
        <line x1="24.2" y1="39.8" x2="15" y2="49" />
        <line x1="21" y1="32" x2="8" y2="32" />
        <line x1="24.2" y1="24.2" x2="15" y2="15" />
        <line x1="32" y1="21" x2="32" y2="8" />
        <line x1="39.8" y1="39.8" x2="49" y2="49" />
      </g>
      <line
        x1="39.8"
        y1="24.2"
        x2="54.5"
        y2="9.5"
        stroke="#d97757"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="6" fill="#ffffff" />
    </svg>
  );
}

// The sidebar-panel (collapse/expand) icon — Claude/ChatGPT style.
function PanelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    </svg>
  );
}

export function AramoBrand() {
  const { collapsed, toggle } = useRailCollapse();

  if (collapsed) {
    return (
      <button
        type="button"
        className="rc-railbrand rc-railbrand--collapsed"
        title="Open sidebar"
        aria-label="Open sidebar"
        onClick={toggle}
      >
        <span className="rc-railbrand__mark rc-railbrand__mark--logo">
          <AramoMark />
        </span>
        <span className="rc-railbrand__mark rc-railbrand__mark--panel">
          <PanelIcon />
        </span>
      </button>
    );
  }

  return (
    <div className="rc-railbrand">
      <Link to="/" className="rc-railbrand__home" aria-label="aramo.ai — home">
        <span className="rc-railbrand__mark">
          <AramoMark />
        </span>
        <span className="rc-railbrand__name">
          aramo<span className="rc-railbrand__ai">.ai</span>
        </span>
      </Link>
      <button
        type="button"
        className="rc-railbrand__collapse"
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
        onClick={toggle}
      >
        <PanelIcon />
      </button>
    </div>
  );
}
