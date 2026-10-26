import { formatTimestamp } from './format-date';

// CCP-UI-V12 (CCP-UI v1.2 handoff §17.4, §14; Charter Amendment A1 AD-2) — the apply deadline of an
// approved request: the drawer fact, the inbox cell and the stepper's Approved chip. `applyBy`
// null = the creation policy declares no apply window ("No apply deadline (policy v{n})").

export type ApplyDeadlineState = 'APPROVED' | 'APPLY_EXPIRED' | 'OTHER';

export interface ApplyDeadlineProps {
  readonly applyBy: Date | null;
  /** The request's snapshotted policy version number (null when it can't be resolved). */
  readonly policyVersion: number | null;
  readonly isRequester: boolean;
  readonly state: ApplyDeadlineState;
  /** Where it renders. */
  readonly variant: 'fact' | 'cell' | 'stepper';
  readonly now: Date;
  /** The amber lead (configuration: the near-expiry threshold, TD-D3-2). */
  readonly nearHours: number;
}

const H = 3_600_000;
const pv = (n: number | null): string => (n === null ? 'policy' : `policy v${n}`);

export interface ApplyDeadlineText {
  readonly text: string;
  readonly tone: 'ink' | 'warn' | 'danger';
}

/** The copy and tone (design `exp` / `expFg` / `abyTxt`). */
export function applyDeadlineText(p: Omit<ApplyDeadlineProps, 'isRequester'> & { readonly isRequester?: boolean }): ApplyDeadlineText {
  const left = p.applyBy === null ? null : Math.max(0, Math.round((p.applyBy.getTime() - p.now.getTime()) / H));
  const near = p.applyBy !== null && p.applyBy.getTime() - p.now.getTime() < p.nearHours * H;
  if (p.state === 'APPLY_EXPIRED') {
    if (p.variant === 'cell') return { text: 'Apply expired', tone: 'danger' };
    return { text: `Apply window closed ${p.applyBy !== null ? formatTimestamp(p.applyBy.toISOString()) : ''} — make a new request`, tone: 'danger' };
  }
  if (p.variant === 'stepper') {
    return { text: p.applyBy === null ? `Approved · no apply deadline (${pv(p.policyVersion)})` : `Approved · apply by ${formatTimestamp(p.applyBy.toISOString())}`, tone: 'ink' };
  }
  if (p.variant === 'cell') {
    return p.applyBy === null ? { text: 'No apply deadline', tone: 'ink' } : { text: `Apply within ${left ?? 0} h`, tone: near ? 'warn' : 'ink' };
  }
  return p.applyBy === null
    ? { text: `No apply deadline (${pv(p.policyVersion)}) · requester applies`, tone: 'ink' }
    : { text: `Apply by ${formatTimestamp(p.applyBy.toISOString())} · ${left ?? 0} h left · requester applies`, tone: near ? 'warn' : 'ink' };
}

export function ApplyDeadline(props: ApplyDeadlineProps) {
  const t = applyDeadlineText(props);
  return (
    <span className={`pc-tone--${t.tone}`} data-testid="apply-deadline">
      {t.text}
    </span>
  );
}
