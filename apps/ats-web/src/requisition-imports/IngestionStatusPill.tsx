import { StatChip } from '../settings/components';
import type { RequisitionImportStatus } from './types';

// T8-P3 — status pill keyed EXACTLY to the canonical backend batch statuses
// (directive §13). Not the stale settings/admin-types `partial`/`failed` aliases.

const TONE: Record<RequisitionImportStatus, 'ok' | 'warn' | 'info' | 'muted'> = {
  pending: 'info',
  committed: 'ok',
  partially_committed: 'warn',
  rejected: 'warn',
  reverted: 'muted',
};

const LABEL: Record<RequisitionImportStatus, string> = {
  pending: 'Pending',
  committed: 'Committed',
  partially_committed: 'Partially committed',
  rejected: 'Rejected',
  reverted: 'Reverted',
};

// A status value the backend has not yet taught the UI still renders (§398/§13
// forward-compat): fall back to the raw value with a neutral tone.
export function statusLabel(status: string): string {
  return (LABEL as Record<string, string | undefined>)[status] ?? status;
}

export function IngestionStatusPill({ status }: { readonly status: string }) {
  const tone = (TONE as Record<string, 'ok' | 'warn' | 'info' | 'muted' | undefined>)[status] ?? 'muted';
  return (
    <StatChip tone={tone} dot>
      {statusLabel(status)}
    </StatChip>
  );
}
