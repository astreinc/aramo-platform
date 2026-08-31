import { useEffect, useState } from 'react';

import { getTalentJourney, type TalentRequisitionJourney } from './talent-journey-api';

// Lane 2 / L2-H — the Unified Talent Journey panel. Renders the BE-composed
// owner-attributed journey as the SINGLE stage source. The current stage is the value the
// server computed from the owning aggregate; the offer/placement/decline labels are
// never re-derived on this surface (the placement-BOARD display utility stays board-local and
// is intentionally not imported here). Each owner-specific action links to its owner's command.
export function TalentJourneyPanel({ pipelineId }: { pipelineId: string }): JSX.Element {
  const [journey, setJourney] = useState<TalentRequisitionJourney | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let live = true;
    getTalentJourney(pipelineId)
      .then((j) => { if (live) setJourney(j); })
      .catch(() => { if (live) setNotFound(true); });
    return () => { live = false; };
  }, [pipelineId]);

  if (notFound) {
    return <div className="rc-journey rc-journey--empty">Journey not available.</div>;
  }
  if (journey === null) {
    return <div className="rc-journey rc-journey--loading">Loading journey…</div>;
  }

  return (
    <section className="rc-journey" aria-label="Talent journey">
      <div className="rc-journey__current" data-testid="journey-current-stage">
        {journey.current_journey_stage}
      </div>
      <ol className="rc-journey__stages">
        {journey.stages.map((s) => (
          <li key={`${s.owner}:${s.source_object_id}:${s.stage}`} className="rc-journey__stage" data-owner={s.owner}>
            <span className="rc-journey__stage-name">{s.stage}</span>
            <span className="rc-journey__stage-owner">{s.owner}</span>
          </li>
        ))}
      </ol>
      {journey.actions.length > 0 && (
        <ul className="rc-journey__actions">
          {journey.actions.map((a) => (
            <li key={`${a.owner}:${a.action}`} className="rc-journey__action" data-owner={a.owner}>
              {a.action}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
