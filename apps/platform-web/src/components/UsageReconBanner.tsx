import { formatTimestamp } from './format-date';
import './finance-components.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.4, §13.10) — the Usage › Consumption status banner, always
// shown: Reconciled (ok, role=status), Reconciliation pending (info, role=status), Not reconciled
// · n mismatches (warn, role=alert). `mode` is optional: the D1 reconciliation read carries no
// run mode (missing backend contract MBC-V12-6), so the line ends at the time.

export type UsageReconStatus = 'RECONCILED' | 'PENDING' | 'NOT_RECONCILED';
export type UsageRunMode = 'FULL' | 'INCREMENTAL' | 'REBUILD';

export interface UsageReconBannerProps {
  readonly status: UsageReconStatus;
  readonly mismatches?: number;
  /** The last run (null: the roll-up worker has never run). */
  readonly lastRun: { readonly at: Date; readonly mode?: UsageRunMode } | null;
}

const MODE: Readonly<Record<UsageRunMode, string>> = { FULL: 'Full', INCREMENTAL: 'Incremental', REBUILD: 'Rebuild' };

function runText(r: UsageReconBannerProps['lastRun'], sep: ' · ' | ' ('): string {
  if (r === null) return '';
  const at = formatTimestamp(r.at.toISOString());
  if (r.mode === undefined) return at;
  return sep === ' · ' ? `${at} · ${MODE[r.mode]}` : `${at} (${MODE[r.mode]})`;
}

export function UsageReconBanner({ status, mismatches = 0, lastRun }: UsageReconBannerProps) {
  if (status === 'RECONCILED') {
    return (
      <div role="status" className="pw-urb pw-urb--ok" data-testid="usage-recon-banner">
        <b>Reconciled.</b> Roll-ups match Sign records.{lastRun !== null ? ` Last run ${runText(lastRun, ' · ')}.` : ''}
      </div>
    );
  }
  if (status === 'PENDING') {
    return (
      <div role="status" className="pw-urb pw-urb--info" data-testid="usage-recon-banner">
        <b>Reconciliation pending.</b>{' '}
        {lastRun !== null ? `A run started ${runText(lastRun, ' (')}${lastRun.mode !== undefined ? ')' : ''}.` : 'No roll-up run has finished yet.'} Figures may change when it finishes.
      </div>
    );
  }
  return (
    <div role="alert" className="pw-urb pw-urb--warn" data-testid="usage-recon-banner">
      <b>Not reconciled · {mismatches} mismatches.</b> The last run{lastRun !== null ? ` (${runText(lastRun, ' · ')})` : ''} found roll-ups that don’t match Sign records.
    </div>
  );
}
