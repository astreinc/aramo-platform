import { Card, CardHead } from '../ui';

import { CommercialRevisionRow, type CommercialRevisionStatus } from './CommercialRevisionRow';
import type { AssignmentCommercialView } from './types';

// Track 6 / T6-B4 §9 — the commercial revision timeline. Consumes the non-cancelled series
// (GET .../revisions, effective_from DESC) and renders ONE chronological list, classifying
// each row as Current / Scheduled / History against a single "now". Cancelled rows are
// absent by contract and are never reconstructed client-side. The Cancel control is
// exposed ONLY on the eligible future open-tail row (Scheduled + open) and ONLY when the
// §6 mutation predicate holds (`canMutate`, which already requires the assignment ACTIVE);
// the server remains authoritative for stale eligibility.
export interface CommercialRevisionTimelineProps {
  readonly series: readonly AssignmentCommercialView[];
  readonly canMutate: boolean;
  readonly onCancel: (version: AssignmentCommercialView) => void;
  /** Injectable clock for deterministic classification in tests; defaults to real now. */
  readonly nowMs?: number;
}

function classify(version: AssignmentCommercialView, nowMs: number): CommercialRevisionStatus {
  const fromMs = new Date(version.effective_from).getTime();
  if (fromMs > nowMs) return 'scheduled';
  const toMs = version.effective_to === null ? null : new Date(version.effective_to).getTime();
  if (toMs === null || toMs > nowMs) return 'current';
  return 'history';
}

// A row is cancellable only if it is the future OPEN tail (Scheduled + effective_to null)
// and the actor satisfies the §6 mutation predicate. Interior/bounded future rows are not
// cancellable (the BE would refuse — cancellation_would_create_gap).
function rowCancellable(
  version: AssignmentCommercialView,
  status: CommercialRevisionStatus,
  canMutate: boolean,
): boolean {
  return canMutate && status === 'scheduled' && version.effective_to === null;
}

export function CommercialRevisionTimeline({
  series,
  canMutate,
  onCancel,
  nowMs,
}: CommercialRevisionTimelineProps) {
  const now = nowMs ?? Date.now();
  return (
    <Card>
      <CardHead title="Commercial revision history" />
      {series.length === 0 ? (
        <p className="rc-muted-line" data-testid="commercial-timeline-empty">
          No commercial revisions recorded yet.
        </p>
      ) : (
        <ul className="rc-deflist" data-testid="commercial-timeline">
          {series.map((version) => {
            const status = classify(version, now);
            return (
              <CommercialRevisionRow
                key={version.assignment_rate_version_id}
                version={version}
                status={status}
                canCancel={rowCancellable(version, status, canMutate)}
                onCancel={onCancel}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}
