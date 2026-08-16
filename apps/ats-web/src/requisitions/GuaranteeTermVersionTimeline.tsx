import { GuaranteeTermVersionRow } from './GuaranteeTermVersionRow';
import type { GuaranteeTermVersionView } from './guarantee-terms-types';

// Track 7 / T7-P5 §5.5 — the guarantee-term version history table. Semantic <table> (§11) of the
// versions (server order: newest effective_from first). Empty state when there are no versions.
export interface GuaranteeTermVersionTimelineProps {
  readonly versions: readonly GuaranteeTermVersionView[];
  readonly nowMs: number;
}

export function GuaranteeTermVersionTimeline({ versions, nowMs }: GuaranteeTermVersionTimelineProps) {
  if (versions.length === 0) {
    return (
      <p className="rc-muted-line" data-testid="guarantee-terms-empty">
        No guarantee terms have been set for this requisition yet.
      </p>
    );
  }
  return (
    <table className="rc-table" data-testid="guarantee-terms-timeline">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Effective from</th>
          <th scope="col">Effective to</th>
          <th scope="col">Duration</th>
          <th scope="col">Remedy policy</th>
          <th scope="col">Exposure</th>
          <th scope="col">Source</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <GuaranteeTermVersionRow key={v.id} version={v} nowMs={nowMs} />
        ))}
      </tbody>
    </table>
  );
}
