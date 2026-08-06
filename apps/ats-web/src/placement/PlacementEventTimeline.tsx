import { PLACEMENT_STATE_LABELS, type PlacementEventView, type PlacementState } from './types';

// E1-d — the placement detail event timeline. This is the AUTHORIZED reason
// surface (D-1): reason_code, reason_label_snapshot and permitted reason_detail
// render HERE, on the placement detail view, and nowhere broader. A legacy /
// non-governed event carries null reason fields and shows no reason (never a
// reason reconstructed from state). reason_detail is absent for a code whose
// registry policy prohibits detail (it is null by construction).
export interface PlacementEventTimelineProps {
  readonly events: readonly PlacementEventView[];
  readonly emptyLabel?: string;
}

function stateLabel(s: string | undefined): string {
  if (s && s in PLACEMENT_STATE_LABELS) return PLACEMENT_STATE_LABELS[s as PlacementState];
  return s ?? '—';
}

export function PlacementEventTimeline({ events, emptyLabel = 'No events yet.' }: PlacementEventTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="placement-timeline placement-timeline--empty" data-testid="placement-timeline-empty">
        {emptyLabel}
      </div>
    );
  }
  return (
    <ol className="placement-timeline" data-testid="placement-timeline">
      {events.map((e) => {
        const hasReason = e.reason_code !== null;
        return (
          <li key={e.id} className="placement-timeline__event" data-testid="placement-timeline-event">
            <span className="placement-timeline__transition">
              {stateLabel(e.event_payload?.from)} → {stateLabel(e.event_payload?.to)}
            </span>
            {hasReason ? (
              <span className="placement-timeline__reason" data-testid="placement-reason">
                <span className="placement-timeline__reason-label" data-testid="placement-reason-label">
                  {e.reason_label_snapshot}
                </span>
                {e.reason_detail !== null ? (
                  <span className="placement-timeline__reason-detail" data-testid="placement-reason-detail">
                    {e.reason_detail}
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
