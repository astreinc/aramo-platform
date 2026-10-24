import type { ReactNode } from 'react';
import { StatusPill, type PillTone } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the ONE status pill system (handoff §3.7). A thin wrapper
// on the fe-foundation StatusPill that maps the platform tone table onto it and
// sizes it to the design (22px, 0 9px, 12px/600, 6px currentColor dot).
//
// `muted` (Offboarding, Closed, Released, Retired, Replaced, Rejected) maps to
// the U-0 StatusPill `muted` tone.

export type PlatformTone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'muted';

/** sm = inline (timeline from → to), md = status pill, lg = dialog Change box. */
export type PillSize = 'sm' | 'md' | 'lg';

export interface PillProps {
  readonly tone: PlatformTone;
  readonly children: ReactNode;
  /** Default: md. */
  readonly size?: PillSize;
  /** The leading 6px dot. Default: true for md, false otherwise. */
  readonly dot?: boolean;
  /** 700 weight (the "to" pill in a Change box). */
  readonly strong?: boolean;
}

const FOUNDATION_TONE: Readonly<Record<PlatformTone, PillTone>> = {
  ok: 'ok',
  info: 'info',
  warn: 'warn',
  danger: 'danger',
  neutral: 'neutral',
  muted: 'muted',
};

export function Pill({ tone, children, size = 'md', dot, strong = false }: PillProps) {
  const showDot = dot ?? size === 'md';
  const cls = ['pw-pill', `pw-pill--${tone}`, `pw-pill--${size}`, strong ? 'pw-pill--strong' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} data-tone={tone}>
      <StatusPill tone={FOUNDATION_TONE[tone]} dot={showDot}>
        {children}
      </StatusPill>
    </span>
  );
}

export interface PillSpec {
  readonly label: string;
  readonly tone: PlatformTone;
}

/** Tenant lifecycle status → label + tone (Platform Admin.dc.html TS). */
export const TENANT_STATUS_PILL: Readonly<Record<string, PillSpec>> = {
  PROVISIONED: { label: 'Provisioned', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'ok' },
  SUSPENDED: { label: 'Suspended', tone: 'warn' },
  OFFBOARDING: { label: 'Offboarding', tone: 'muted' },
  CLOSED: { label: 'Closed', tone: 'muted' },
};

/** The pill spec for a tenant status; an unknown status renders neutral with its code. */
export function tenantStatusPill(status: string): PillSpec {
  return TENANT_STATUS_PILL[status] ?? { label: status, tone: 'neutral' };
}
