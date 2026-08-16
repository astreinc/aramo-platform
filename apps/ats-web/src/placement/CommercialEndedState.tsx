import { formatInstant } from '../format/date';
import { Card, CardHead } from '../ui';

import { CommercialRevisionTimeline } from './CommercialRevisionTimeline';
import type { AssignmentCommercialView } from './types';

// Track 6 / T6-B4 §18 + ENDED-State Read-Surface Amendment §3/§4/§6 — the ENDED commercial
// presentation. The assignment lifecycle is ENDED, so NO create/cancel controls are shown
// and NO affordance implies reopening. The commercial end instant is NOT a separately
// fetched ContractAssignment.ended_at (that field is not on any FE read surface); by the
// B3 reconciliation invariant the final surviving non-cancelled window's effective_to
// EQUALS the assignment T_end, so this displays that boundary, labelled "Commercials ended".
// If no surviving non-cancelled window exists (zero-surviving fallback), the timestamp is
// OMITTED — never synthesized, never an extra backend call, and absence is not an error.
// Readable commercial history remains via the (mutation-free) timeline.
export interface CommercialEndedStateProps {
  readonly series: readonly AssignmentCommercialView[];
  /** Injectable clock for deterministic timeline classification in tests. */
  readonly nowMs?: number;
}

// The end instant = the latest (max) effective_to across the surviving non-cancelled
// series. For an ENDED assignment every surviving window is bounded, and the final window's
// effective_to == T_end (B3 §16). Returns null when nothing survives → omit the timestamp.
function finalEndInstant(series: readonly AssignmentCommercialView[]): string | null {
  let latest: string | null = null;
  for (const v of series) {
    if (v.effective_to === null) continue;
    if (latest === null || new Date(v.effective_to).getTime() > new Date(latest).getTime()) {
      latest = v.effective_to;
    }
  }
  return latest;
}

export function CommercialEndedState({ series, nowMs }: CommercialEndedStateProps) {
  const endedAt = finalEndInstant(series);
  return (
    <section className="rc-stack" data-testid="commercials-ended-state">
      <Card>
        <CardHead title="Commercials (assignment ended)" />
        {endedAt === null ? (
          <p className="rc-muted-line" data-testid="commercials-ended-no-timestamp">
            This assignment has ended. No commercial end date is available.
          </p>
        ) : (
          <dl className="rc-deflist" data-testid="commercials-ended-detail">
            <div className="rc-defrow">
              <dt>Commercials ended</dt>
              <dd>
                <time dateTime={endedAt} data-testid="commercials-ended-at">
                  {formatInstant(endedAt)}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </Card>
      {/* Readable commercial history remains; no cancel controls (canMutate=false). */}
      <CommercialRevisionTimeline series={series} canMutate={false} onCancel={() => undefined} nowMs={nowMs} />
    </section>
  );
}
