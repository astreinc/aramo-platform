import type { ReactNode } from 'react';

import './platform-components.css';
import './ccp-components.css';

// CCP-B1 — the bootstrap banner (CCP-UI v1.0 handoff §3.2, §6 "Bootstrap banner:
// InlineAlert (warning) full-width"; InlineAlert in fe-foundation is frozen, so this
// is a local NEW component, R-3). An amber full-width strip under the top bar,
// role="alert": the chains that have too few distinct eligible approvers, and the
// 409 the approve route returns for them.

export interface BootstrapBannerProps {
  /** "Above threshold (Finance → Owner)", … */
  readonly chains: readonly string[];
  /** An optional trailing action (the design's "View chains"). */
  readonly action?: ReactNode;
}

export function BootstrapBanner({ chains, action }: BootstrapBannerProps) {
  if (chains.length === 0) return null;
  return (
    <div role="alert" className="pw-bootbanner" data-testid="bootstrap-banner">
      <b className="pw-bootbanner__lead">Commercial approvals unavailable: not enough distinct approvers for {chains.join(', ')}.</b>
      <span>
        Approvals on these chains return <span className="pw-mono">409 CCP_NOT_BOOTSTRAPPED</span>.
      </span>
      {action !== undefined ? <span className="pw-bootbanner__action">{action}</span> : null}
    </div>
  );
}
